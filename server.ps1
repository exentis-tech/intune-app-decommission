<#
.SYNOPSIS
    Local backend for Intune App Decommission.

.DESCRIPTION
    Reads config.json (tenant, application ID, client secret), gets an app-only
    Microsoft Graph token with the client-credentials flow, serves the web UI and
    proxies the Graph calls the UI needs. The client secret never reaches the browser.

    Safety rails enforced here, independently of the UI:
      * Listens on loopback only (127.0.0.1 / localhost / ::1).
      * Every API call needs a per-launch session token.
      * Reads are limited to deviceAppManagement, deviceManagement, groups and organization.
      * Writes are limited to three DELETE shapes: an app, an app assignment, a group.
      * With "EnableRealDelete": false, every DELETE is refused (dry run only).
      * Every write attempt is appended to logs/audit-<date>.jsonl.

.PARAMETER ConfigPath
    Path to the JSON config. Defaults to config.json next to this script.

.PARAMETER NoBrowser
    Do not open the browser on start.

.EXAMPLE
    pwsh ./server.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\server.ps1 -ConfigPath D:\secure\tenant-a.json
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot 'config.json'),
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Version = '1.0.0'
$WebRoot = [IO.Path]::GetFullPath($PSScriptRoot)
Add-Type -AssemblyName System.Net.Http
# Windows PowerShell 5.1 on older .NET Framework may not offer TLS 1.2 by default.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$OnLinux = (Test-Path variable:IsLinux) -and $IsLinux
$OnMac = (Test-Path variable:IsMacOS) -and $IsMacOS

# ------------------------------------------------------------------ helpers

function Write-Info([string]$Message, [string]$Color = 'Gray') {
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message) -ForegroundColor $Color
}

function Get-Opt($Object, [string]$Name, $Default) {
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    if ($p.Value -is [string] -and $p.Value.Trim() -eq '') { return $Default }
    return $p.Value
}

function ConvertTo-Bool($Value) {
    if ($Value -is [bool]) { return $Value }
    return ([string]$Value).Trim() -match '^(true|1|yes)$'
}

function ConvertFrom-Base64Url([string]$Text) {
    $s = $Text.Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))
}

function New-RandomHex([int]$Bytes = 32) {
    $b = New-Object byte[] $Bytes
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($b)
    $rng.Dispose()
    return -join ($b | ForEach-Object { $_.ToString('x2') })
}

# ------------------------------------------------------------------ config

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Config file not found: $ConfigPath`nCopy config.example.json to config.json and fill in TenantId, ApplicationId and ClientSecret."
}
try {
    $raw = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "config.json is not valid JSON: $($_.Exception.Message)"
}

$Cfg = [ordered]@{
    TenantId                   = [string](Get-Opt $raw 'TenantId' '')
    ApplicationId              = [string](Get-Opt $raw 'ApplicationId' '')
    ClientSecret               = [string](Get-Opt $raw 'ClientSecret' '')
    GraphBaseUrl               = ([string](Get-Opt $raw 'GraphBaseUrl' 'https://graph.microsoft.com/v1.0')).TrimEnd('/')
    GraphBetaBaseUrl           = ([string](Get-Opt $raw 'GraphBetaBaseUrl' 'https://graph.microsoft.com/beta')).TrimEnd('/')
    AuthorityHost              = ([string](Get-Opt $raw 'AuthorityHost' 'https://login.microsoftonline.com')).TrimEnd('/')
    ListenPrefix               = [string](Get-Opt $raw 'ListenPrefix' 'http://127.0.0.1:8088/')
    AllowedOrigin              = ([string](Get-Opt $raw 'AllowedOrigin' '')).TrimEnd('/')
    EnableRealDelete           = ConvertTo-Bool (Get-Opt $raw 'EnableRealDelete' $false)
    RequestTimeoutSeconds      = [int](Get-Opt $raw 'RequestTimeoutSeconds' 60)
    ProxyUrl                   = [string](Get-Opt $raw 'ProxyUrl' '')
    UseDefaultProxyCredentials = ConvertTo-Bool (Get-Opt $raw 'UseDefaultProxyCredentials' $false)
}
# Optional: keep the secret out of the file and supply it per session.
if ($env:IAD_CLIENT_SECRET) { $Cfg.ClientSecret = $env:IAD_CLIENT_SECRET }

foreach ($k in 'TenantId', 'ApplicationId', 'ClientSecret') {
    if (-not $Cfg[$k] -or $Cfg[$k] -match '^(YOUR_|PASTE_)') { throw "config.json: '$k' is not set." }
}
$guid = [guid]::Empty
if (-not [guid]::TryParse($Cfg.ApplicationId, [ref]$guid)) { throw "config.json: 'ApplicationId' must be a GUID." }
if ($Cfg.RequestTimeoutSeconds -lt 5) { $Cfg.RequestTimeoutSeconds = 5 }
if (-not $Cfg.ListenPrefix.EndsWith('/')) { $Cfg.ListenPrefix += '/' }

$ListenUri = $null
if (-not [Uri]::TryCreate($Cfg.ListenPrefix, [UriKind]::Absolute, [ref]$ListenUri)) {
    throw "ListenPrefix must be a loopback URL such as http://127.0.0.1:8088/ (got '$($Cfg.ListenPrefix)')."
}
if (@('127.0.0.1', 'localhost', '[::1]', '::1') -notcontains $ListenUri.Host) {
    throw "ListenPrefix must be a loopback address (127.0.0.1 or localhost). '$($ListenUri.Host)' would expose an admin proxy to the network."
}
$OwnOrigin = '{0}://{1}' -f $ListenUri.Scheme, $ListenUri.Authority
$GraphHost = ([Uri]$Cfg.GraphBaseUrl).GetLeftPart([UriPartial]::Authority)

if ($Cfg.AllowedOrigin -eq '*') {
    Write-Info "AllowedOrigin '*' is ignored: the local API only answers its own page ($OwnOrigin). Set an exact origin to allow another front end." 'Yellow'
    $Cfg.AllowedOrigin = ''
}

# ------------------------------------------------------------------ HTTP client

$handler = New-Object System.Net.Http.HttpClientHandler
if ($Cfg.ProxyUrl) {
    $proxy = New-Object System.Net.WebProxy($Cfg.ProxyUrl)
    $proxy.UseDefaultCredentials = $Cfg.UseDefaultProxyCredentials
    $handler.Proxy = $proxy
    $handler.UseProxy = $true
} elseif ($Cfg.UseDefaultProxyCredentials) {
    try { $handler.DefaultProxyCredentials = [Net.CredentialCache]::DefaultCredentials } catch { }
}
$Http = New-Object System.Net.Http.HttpClient($handler)
$Http.Timeout = [TimeSpan]::FromSeconds($Cfg.RequestTimeoutSeconds)
$Http.DefaultRequestHeaders.UserAgent.ParseAdd("IntuneAppDecommission/$Version")

# ------------------------------------------------------------------ token

$script:Token = $null
$script:TokenExpires = [DateTime]::MinValue
$script:Roles = @()
$script:AppName = ''

function Get-GraphToken([switch]$Force) {
    if (-not $Force -and $script:Token -and $script:TokenExpires -gt (Get-Date).AddMinutes(5)) { return $script:Token }
    $form = 'client_id={0}&client_secret={1}&scope={2}&grant_type=client_credentials' -f `
        [Uri]::EscapeDataString($Cfg.ApplicationId),
        [Uri]::EscapeDataString($Cfg.ClientSecret),
        [Uri]::EscapeDataString("$GraphHost/.default")
    $content = New-Object System.Net.Http.StringContent($form, [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
    $url = '{0}/{1}/oauth2/v2.0/token' -f $Cfg.AuthorityHost, [Uri]::EscapeDataString($Cfg.TenantId)
    $resp = $Http.PostAsync($url, $content).GetAwaiter().GetResult()
    $text = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    if (-not $resp.IsSuccessStatusCode) {
        $detail = $text
        try { $j = $text | ConvertFrom-Json; $detail = "$($j.error): $($j.error_description)" } catch { }
        throw "Token request failed ($([int]$resp.StatusCode)). $detail"
    }
    $tok = $text | ConvertFrom-Json
    $script:Token = $tok.access_token
    $script:TokenExpires = (Get-Date).AddSeconds([int]$tok.expires_in)
    try {
        $claims = ConvertFrom-Base64Url ($tok.access_token.Split('.')[1]) | ConvertFrom-Json
        $script:Roles = @(Get-Opt $claims 'roles' @())
        $script:AppName = [string](Get-Opt $claims 'app_displayname' '')
    } catch {
        $script:Roles = @()
    }
    return $script:Token
}

# ------------------------------------------------------------------ Graph policy

# Paths are relative to the Graph version root, without the query string.
$ReadAllow = '^/(deviceAppManagement|deviceManagement|groups|organization)(/|$)'
$WriteAllow = @(
    '^/deviceAppManagement/mobileApps/[^/]+$',
    '^/deviceAppManagement/mobileApps/[^/]+/assignments/[^/]+$',
    '^/groups/[^/]+$'
)

function Test-WriteAllowed([string]$Path) {
    foreach ($re in $WriteAllow) { if ($Path -match $re) { return $true } }
    return $false
}

$LogDir = Join-Path $WebRoot 'logs'
function Write-Audit([hashtable]$Entry) {
    try {
        if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
        $Entry['at'] = (Get-Date).ToString('o')
        $Entry['tenantId'] = $Cfg.TenantId
        $line = ($Entry | ConvertTo-Json -Compress -Depth 5)
        $file = Join-Path $LogDir ('audit-{0}.jsonl' -f (Get-Date -Format 'yyyy-MM-dd'))
        [IO.File]::AppendAllText($file, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    } catch {
        Write-Info "Could not write audit log: $($_.Exception.Message)" 'Yellow'
    }
}

function Invoke-Graph([string]$Method, [string]$Url, [string]$Body, [hashtable]$Headers) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        $msg = New-Object System.Net.Http.HttpRequestMessage((New-Object System.Net.Http.HttpMethod($Method)), $Url)
        $msg.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue('Bearer', (Get-GraphToken -Force:($attempt -gt 1)))
        if ($Headers) { foreach ($k in $Headers.Keys) { [void]$msg.Headers.TryAddWithoutValidation($k, [string]$Headers[$k]) } }
        if ($Body) { $msg.Content = New-Object System.Net.Http.StringContent($Body, [Text.Encoding]::UTF8, 'application/json') }
        try {
            $resp = $Http.SendAsync($msg).GetAwaiter().GetResult()
        } catch [System.Threading.Tasks.TaskCanceledException] {
            return @{ Status = 504; Bytes = [Text.Encoding]::UTF8.GetBytes('{"error":{"code":"GatewayTimeout","message":"Graph did not answer within RequestTimeoutSeconds."}}'); ContentType = 'application/json'; RetryAfter = $null }
        }
        if ([int]$resp.StatusCode -eq 401 -and $attempt -eq 1) { continue }
        $retry = $null
        if ($resp.Headers.RetryAfter -and $resp.Headers.RetryAfter.Delta) { $retry = [int]$resp.Headers.RetryAfter.Delta.TotalSeconds }
        $ct = 'application/json'
        if ($resp.Content.Headers.ContentType) { $ct = $resp.Content.Headers.ContentType.ToString() }
        return @{
            Status      = [int]$resp.StatusCode
            Bytes       = $resp.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
            ContentType = $ct
            RetryAfter  = $retry
        }
    }
}

# ------------------------------------------------------------------ responses

$SecurityHeaders = @{
    'X-Content-Type-Options' = 'nosniff'
    'Referrer-Policy'        = 'no-referrer'
    'Cache-Control'          = 'no-store'
}
$Csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://login.microsoftonline.com https://graph.microsoft.com; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

function Send-Bytes($Ctx, [int]$Status, [byte[]]$Bytes, [string]$ContentType, [hashtable]$Extra) {
    $res = $Ctx.Response
    $res.StatusCode = $Status
    foreach ($k in $SecurityHeaders.Keys) { $res.Headers[$k] = $SecurityHeaders[$k] }
    if ($Extra) { foreach ($k in $Extra.Keys) { $res.Headers[$k] = [string]$Extra[$k] } }
    if ($ContentType) { $res.ContentType = $ContentType }
    if ($null -eq $Bytes) { $Bytes = [byte[]]@() }
    $res.ContentLength64 = $Bytes.Length
    if ($Bytes.Length) { $res.OutputStream.Write($Bytes, 0, $Bytes.Length) }
}

function Send-Json($Ctx, [int]$Status, $Object, [hashtable]$Extra) {
    $json = $Object | ConvertTo-Json -Depth 10 -Compress
    Send-Bytes $Ctx $Status ([Text.Encoding]::UTF8.GetBytes($json)) 'application/json; charset=utf-8' $Extra
}

function Send-Error($Ctx, [int]$Status, [string]$Code, [string]$Message, [hashtable]$Extra) {
    Send-Json $Ctx $Status @{ error = @{ code = $Code; message = $Message } } $Extra
}

$Mime = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.png' = 'image/png'; '.svg' = 'image/svg+xml' }

function Send-Static($Ctx) {
    $p = [Uri]::UnescapeDataString($Ctx.Request.Url.AbsolutePath)
    if ($p -eq '/') { $p = '/index.html' }
    # Only the UI files are served; config.json, logs and scripts never are.
    if ($p -notmatch '^/(index\.html|css/[\w-]+\.css|js/[\w-]+\.js|docs/[\w-]+\.(png|svg))$') {
        return Send-Error $Ctx 404 'NotFound' 'Not found'
    }
    $full = [IO.Path]::GetFullPath((Join-Path $WebRoot $p.TrimStart('/')))
    if (-not $full.StartsWith($WebRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        return Send-Error $Ctx 404 'NotFound' 'Not found'
    }
    $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
    Send-Bytes $Ctx 200 ([IO.File]::ReadAllBytes($full)) $Mime[$ext] @{ 'Content-Security-Policy' = $Csp }
}

# ------------------------------------------------------------------ routes

$SessionToken = New-RandomHex 32
$script:TenantLabel = $null

function Get-TenantLabel {
    if ($null -ne $script:TenantLabel) { return $script:TenantLabel }
    $script:TenantLabel = $Cfg.TenantId
    try {
        $r = Invoke-Graph 'GET' "$($Cfg.GraphBaseUrl)/organization?`$select=displayName,verifiedDomains" $null $null
        if ($r.Status -eq 200) {
            $org = ([Text.Encoding]::UTF8.GetString($r.Bytes) | ConvertFrom-Json).value | Select-Object -First 1
            $def = $org.verifiedDomains | Where-Object { $_.isDefault } | Select-Object -First 1
            if ($def) { $script:TenantLabel = $def.name } elseif ($org.displayName) { $script:TenantLabel = $org.displayName }
        }
    } catch { }
    return $script:TenantLabel
}

function Get-CorsHeaders($Ctx) {
    $origin = $Ctx.Request.Headers['Origin']
    if ($Cfg.AllowedOrigin -and $origin -eq $Cfg.AllowedOrigin) {
        return @{
            'Access-Control-Allow-Origin'  = $origin
            'Access-Control-Allow-Headers' = 'Content-Type, X-IAD-Session, ConsistencyLevel'
            'Access-Control-Allow-Methods' = 'GET, POST, DELETE'
            'Vary'                         = 'Origin'
        }
    }
    return @{}
}

function Test-OriginOk($Ctx) {
    $origin = $Ctx.Request.Headers['Origin']
    if (-not $origin) { return $true }
    return ($origin -eq $OwnOrigin -or ($Cfg.AllowedOrigin -and $origin -eq $Cfg.AllowedOrigin))
}

function Invoke-Session($Ctx) {
    [void](Get-GraphToken)
    Send-Json $Ctx 200 ([ordered]@{
        mode             = 'app'
        version          = $Version
        tenantId         = $Cfg.TenantId
        tenantLabel      = (Get-TenantLabel)
        applicationId    = $Cfg.ApplicationId
        appDisplayName   = $script:AppName
        roles            = @($script:Roles)
        enableRealDelete = $Cfg.EnableRealDelete
        sessionToken     = $SessionToken
    }) (Get-CorsHeaders $Ctx)
}

function Invoke-GraphProxy($Ctx) {
    $req = $Ctx.Request
    $cors = Get-CorsHeaders $Ctx
    if ($req.Headers['X-IAD-Session'] -ne $SessionToken) {
        return Send-Error $Ctx 401 'SessionInvalid' 'Missing or stale session token. Reload the page.' $cors
    }
    if ($req.RawUrl -notmatch '^/graph/(beta|v1\.0)(/[^?]*)(\?.*)?$') {
        return Send-Error $Ctx 404 'NotFound' 'Unknown Graph route' $cors
    }
    $ver = $Matches[1]
    $rawPath = $Matches[2]
    $query = if ($Matches.ContainsKey(3)) { $Matches[3] } else { '' }
    $path = [Uri]::UnescapeDataString($rawPath)
    $method = $req.HttpMethod.ToUpperInvariant()
    $base = if ($ver -eq 'beta') { $Cfg.GraphBetaBaseUrl } else { $Cfg.GraphBaseUrl }

    $body = $null
    if ($req.HasEntityBody) {
        $reader = New-Object IO.StreamReader($req.InputStream, [Text.Encoding]::UTF8)
        $body = $reader.ReadToEnd()
        $reader.Dispose()
    }

    $isWrite = $false
    if ($method -eq 'GET') {
        if ($path -notmatch $ReadAllow) { return Send-Error $Ctx 403 'NotAllowed' "Reading $path is not allowed by this tool." $cors }
    } elseif ($method -eq 'POST' -and $path -eq '/$batch') {
        try { $batch = $body | ConvertFrom-Json } catch { return Send-Error $Ctx 400 'BadRequest' 'Invalid $batch body.' $cors }
        foreach ($r in @($batch.requests)) {
            $m = ([string](Get-Opt $r 'method' 'GET')).ToUpperInvariant()
            $u = '/' + ([string]$r.url).TrimStart('/').Split('?')[0]
            if ($m -ne 'GET' -or $u -notmatch $ReadAllow) {
                return Send-Error $Ctx 403 'NotAllowed' 'Only read requests are allowed inside $batch.' $cors
            }
        }
    } elseif ($method -eq 'DELETE') {
        $isWrite = $true
        if (-not (Test-WriteAllowed $path)) {
            Write-Audit @{ method = $method; path = $path; result = 'blocked'; reason = 'not an allowed write' }
            return Send-Error $Ctx 403 'NotAllowed' "Deleting $path is not allowed by this tool." $cors
        }
        if (-not $Cfg.EnableRealDelete) {
            Write-Audit @{ method = $method; path = $path; result = 'blocked'; reason = 'EnableRealDelete=false' }
            Write-Info "BLOCKED  DELETE $path (EnableRealDelete is false)" 'Yellow'
            return Send-Error $Ctx 403 'RealDeleteDisabled' 'EnableRealDelete is false in config.json, so the server refused this delete.' $cors
        }
    } else {
        return Send-Error $Ctx 405 'MethodNotAllowed' "$method is not allowed." $cors
    }

    $headers = @{}
    $cl = $req.Headers['ConsistencyLevel']
    if ($cl) { $headers['ConsistencyLevel'] = $cl }

    $r = Invoke-Graph $method ($base + $rawPath + $query) $body $headers
    if ($isWrite) {
        $ok = $r.Status -ge 200 -and $r.Status -lt 300
        Write-Audit @{ method = $method; path = $path; status = $r.Status; result = $(if ($ok) { 'success' } else { 'failed' }) }
        Write-Info ('{0}  DELETE {1} -> {2}' -f $(if ($ok) { 'DONE   ' } else { 'FAILED ' }), $path, $r.Status) $(if ($ok) { 'Green' } else { 'Red' })
    }
    $extra = @{} + $cors
    if ($null -ne $r.RetryAfter) { $extra['Retry-After'] = $r.RetryAfter }
    Send-Bytes $Ctx $r.Status $r.Bytes $r.ContentType $extra
}

function Invoke-Request($Ctx) {
    $req = $Ctx.Request
    # Reject requests addressed to another host name (DNS rebinding).
    $hostHeader = [string]$req.Headers['Host']
    if ($hostHeader -ne $ListenUri.Authority -and $hostHeader -notmatch '^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$') {
        return Send-Error $Ctx 421 'MisdirectedRequest' 'Unexpected Host header.'
    }
    $path = $req.Url.AbsolutePath
    if ($path -eq '/api/session' -or $path.StartsWith('/graph/')) {
        if (-not (Test-OriginOk $Ctx)) { return Send-Error $Ctx 403 'OriginNotAllowed' 'Cross-origin calls are not allowed.' }
        if ($req.HttpMethod -eq 'OPTIONS') { return Send-Bytes $Ctx 204 $null $null (Get-CorsHeaders $Ctx) }
        if ($path -eq '/api/session') {
            if ($req.HttpMethod -ne 'GET') { return Send-Error $Ctx 405 'MethodNotAllowed' 'GET only.' }
            return Invoke-Session $Ctx
        }
        return Invoke-GraphProxy $Ctx
    }
    if ($req.HttpMethod -ne 'GET') { return Send-Error $Ctx 405 'MethodNotAllowed' 'GET only.' }
    Send-Static $Ctx
}

# ------------------------------------------------------------------ start

Write-Host ''
Write-Host "  Intune App Decommission  v$Version" -ForegroundColor Cyan
Write-Host ''
Write-Info "Config:        $ConfigPath"
Write-Info "Tenant:        $($Cfg.TenantId)"
Write-Info "Application:   $($Cfg.ApplicationId)"
if ($Cfg.ProxyUrl) { Write-Info "Proxy:         $($Cfg.ProxyUrl)" }

try {
    [void](Get-GraphToken)
} catch {
    Write-Info $_.Exception.Message 'Red'
    Write-Info 'Check TenantId, ApplicationId and ClientSecret (is the secret expired?).' 'Red'
    exit 1
}
Write-Info ("Signed in as:  {0}" -f $(if ($script:AppName) { $script:AppName } else { 'app registration' })) 'Green'
Write-Info ("Permissions:   {0}" -f $(if ($script:Roles.Count) { $script:Roles -join ', ' } else { '(none granted)' }))

$need = @{
    'DeviceManagementApps.ReadWrite.All'     = 'read apps, remove assignments and delete apps'
    'Group.ReadWrite.All'                    = 'delete groups (Group.Read.All is enough to read them)'
    'DeviceManagementConfiguration.Read.All' = 'check group usage in policies (optional)'
}
foreach ($k in $need.Keys) {
    $alt = $k -replace 'ReadWrite', 'Read'
    $has = $script:Roles -contains $k -or ($k -like '*Configuration.Read.All' -and $script:Roles -contains 'DeviceManagementConfiguration.ReadWrite.All')
    if (-not $has) {
        $partial = $script:Roles -contains $alt
        Write-Info ("Missing:       {0} - needed to {1}{2}" -f $k, $need[$k], $(if ($partial) { " (you have $alt)" } else { '' })) 'Yellow'
    }
}
if ($Cfg.EnableRealDelete) {
    Write-Info 'Real deletes:  ENABLED - live actions in the UI will change the tenant.' 'Red'
} else {
    Write-Info 'Real deletes:  disabled (EnableRealDelete=false). The UI runs in dry run only.' 'Green'
}

$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add($Cfg.ListenPrefix)
try {
    $Listener.Start()
} catch {
    Write-Info "Could not listen on $($Cfg.ListenPrefix): $($_.Exception.Message)" 'Red'
    if ($_.Exception.Message -match 'denied') {
        Write-Info "Windows needs permission to listen on this address. Either use ""ListenPrefix"": ""http://localhost:$($ListenUri.Port)/"", run once elevated, or reserve it:" 'Yellow'
        Write-Info "  netsh http add urlacl url=$($Cfg.ListenPrefix) user=$env:USERDOMAIN\$env:USERNAME" 'Yellow'
    } else {
        Write-Info 'Is another instance running, or the port in use? Change ListenPrefix in config.json.' 'Red'
    }
    exit 1
}
Write-Info "Open:          $($Cfg.ListenPrefix)" 'Cyan'
Write-Info 'Press Ctrl+C to stop.'

if (-not $NoBrowser) {
    try {
        if ($OnLinux) { Start-Process 'xdg-open' $Cfg.ListenPrefix }
        elseif ($OnMac) { Start-Process 'open' $Cfg.ListenPrefix }
        else { Start-Process $Cfg.ListenPrefix }
    } catch { }
}

try {
    while ($Listener.IsListening) {
        $task = $Listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
        $ctx = $task.GetAwaiter().GetResult()
        try {
            Invoke-Request $ctx
        } catch {
            Write-Info "Error: $($_.Exception.Message)" 'Red'
            try { Send-Error $ctx 500 'ServerError' $_.Exception.Message } catch { }
        } finally {
            try { $ctx.Response.Close() } catch { }
        }
    }
} finally {
    $Listener.Stop()
    $Listener.Close()
    $Http.Dispose()
    Write-Info 'Stopped.'
}
