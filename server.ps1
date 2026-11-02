# Clock Player ローカルサーバー
# ダウンロードしたフォルダを http://127.0.0.1:<ポート>/ で配信し、曲（bgm/）と設定（data/）をディスクに保存する。
# Windows 標準の PowerShell 5.1 で動くように書いている（追加のインストールは不要）。
#   start.bat            : このウィンドウで起動し、閉じると停止する
#   start_background.bat : ウィンドウを出さずに起動する
#   stop_background.bat  : 起動中のサーバーを止める（-Stop）
param(
    [switch]$Background,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DataDir = Join-Path $Root 'data'
$BgmDir = Join-Path $Root 'bgm'
$PidFile = Join-Path $DataDir 'server.pid'
$PortFile = Join-Path $DataDir 'port.js'
$SettingsFile = Join-Path $DataDir 'server.json'
$LogFile = Join-Path $DataDir 'server.log'
$DefaultPort = 8137
$PortAttempts = 10

# --- リクエストを処理する関数群。接続ごとに別の runspace で読み込むので、ここだけで完結させる ---
$Common = {
    $ErrorActionPreference = 'Stop'
    $FOLDERS = @('bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF')
    $AUDIO_PATTERN = '^\.(mp3|wav|ogg|m4a|aac|flac)$'
    $UTF8 = New-Object System.Text.UTF8Encoding $false
    $LATIN1 = [System.Text.Encoding]::GetEncoding(28591)
    $MIME = @{
        '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
        '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
        '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.ico' = 'image/x-icon'
        '.md' = 'text/plain; charset=utf-8'; '.txt' = 'text/plain; charset=utf-8'
        '.mp3' = 'audio/mpeg'; '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'; '.m4a' = 'audio/mp4'
        '.aac' = 'audio/aac'; '.flac' = 'audio/flac'
    }

    # 書きかけのファイルが残らないよう、一時ファイルに書いてから置き換える
    function Write-TextFile($Path, $Text) {
        $tmp = "$Path.tmp"
        [System.IO.File]::WriteAllText($tmp, $Text, $UTF8)
        Move-Item -LiteralPath $tmp -Destination $Path -Force
    }

    # ドックに登録する file:/// の URL を作る（空白や日本語は % で表す）
    function Get-FileUrl($Path) {
        $p = ([string]$Path).Replace('\', '/').TrimStart('/')
        return (New-Object System.Uri ('file:///' + $p)).AbsoluteUri
    }

    function Read-TextFile($Path) {
        if (-not (Test-Path -LiteralPath $Path)) { return $null }
        return [System.IO.File]::ReadAllText($Path, $UTF8)
    }

    # --- 曲リスト（data/manifest.json） ---
    function New-EmptyManifest {
        $m = [ordered]@{}
        foreach ($f in $FOLDERS) { $m[$f] = New-Object System.Collections.ArrayList }
        return $m
    }

    function New-Entry($Name, $Path, $Artist, $Title) {
        return [ordered]@{ name = [string]$Name; path = [string]$Path; artist = [string]$Artist; title = [string]$Title }
    }

    function Read-Manifest($Shared) {
        $m = New-EmptyManifest
        $text = Read-TextFile (Join-Path $Shared.DataDir 'manifest.json')
        if (-not $text) { return $m }
        try { $data = ConvertFrom-Json $text } catch { return $m }
        foreach ($f in $FOLDERS) {
            if ($null -eq $data.$f) { continue }
            foreach ($e in @($data.$f)) {
                [void]$m[$f].Add((New-Entry $e.name $e.path $e.artist $e.title))
            }
        }
        return $m
    }

    function Save-Manifest($Shared, $Manifest) {
        Write-TextFile (Join-Path $Shared.DataDir 'manifest.json') (ConvertTo-Json -InputObject $Manifest -Depth 5 -Compress)
    }

    # ファイル名が「アーティスト - 曲名」ならそれを使う
    function Split-TrackName($FileName) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($FileName)
        if ($base -match '^(.+?)\s*-\s*(.+)$') {
            return @($Matches[1].Trim(), $Matches[2].Trim())
        }
        return @('', $base)
    }

    # Windows のエクスプローラーが読み取る曲情報（アーティスト・タイトル）を使うための準備
    function New-MetaReader($Shared) {
        if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') { return $null }
        try {
            $shell = New-Object -ComObject Shell.Application
        } catch {
            return $null
        }
        $reader = @{ Shell = $shell; Artist = 13; AlbumArtist = 186; Title = 21; Folders = @{} }
        # 列の番号は Windows の版や言語で変わるので、見出しの名前から探す
        $artistNames = @('Contributing artists', 'Authors', 'Artist',
            (-join ([char[]](0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8))),
            (-join ([char[]](0x53C2, 0x52A0, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8))))
        $albumArtistNames = @('Album artist', 'AlbumArtist',
            (-join ([char[]](0x30A2, 0x30EB, 0x30D0, 0x30E0, 0x3000, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8))),
            (-join ([char[]](0x30A2, 0x30EB, 0x30D0, 0x30E0, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8))))
        $titleNames = @('Title', (-join ([char[]](0x30BF, 0x30A4, 0x30C8, 0x30EB))))
        $ns = $shell.NameSpace($Shared.BgmDir)
        if ($ns) {
            for ($i = 0; $i -lt 300; $i++) {
                $name = $ns.GetDetailsOf($null, $i)
                if ($artistNames -contains $name) { $reader.Artist = $i }
                if ($albumArtistNames -contains $name) { $reader.AlbumArtist = $i }
                if ($titleNames -contains $name) { $reader.Title = $i }
            }
        }
        return $reader
    }

    function Read-Meta($Reader, $File) {
        $result = @{ Artist = ''; Title = '' }
        if (-not $Reader) { return $result }
        try {
            $dir = $File.DirectoryName
            if (-not $Reader.Folders.ContainsKey($dir)) { $Reader.Folders[$dir] = $Reader.Shell.NameSpace($dir) }
            $ns = $Reader.Folders[$dir]
            $item = $ns.ParseName($File.Name)
            $artist = $ns.GetDetailsOf($item, $Reader.Artist)
            if ([string]::IsNullOrWhiteSpace($artist)) { $artist = $ns.GetDetailsOf($item, $Reader.AlbumArtist) }
            $result.Artist = ([string]$artist).Trim()
            $result.Title = ([string]$ns.GetDetailsOf($item, $Reader.Title)).Trim()
        } catch {
            # 読めなければファイル名を使う
        }
        return $result
    }

    function New-ScannedEntry($Reader, $File, $RelPath) {
        $parts = Split-TrackName $File.Name
        $artist = $parts[0]; $title = $parts[1]
        if (-not $artist) {
            $meta = Read-Meta $Reader $File
            if ($meta.Artist) { $artist = $meta.Artist }
            if ($meta.Title) { $title = $meta.Title }
        }
        return New-Entry $File.Name $RelPath $artist $title
    }

    # bgm フォルダを走査して曲リストを作り直す。分かっている曲は記録をそのまま使い、新しい曲だけ曲情報を読む。
    # 無くなった曲の件数を返す
    function Update-Manifest($Shared) {
        $old = Read-Manifest $Shared
        $known = @{}
        foreach ($f in $FOLDERS) { foreach ($e in $old[$f]) { $known[$e.path] = $e } }
        $new = New-EmptyManifest
        $reader = $null
        foreach ($f in $FOLDERS) {
            $dir = Join-Path $Shared.BgmDir $f
            if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
            $dirFull = (Get-Item -LiteralPath $dir).FullName
            $files = @(Get-ChildItem -LiteralPath $dirFull -File -Recurse | Where-Object { $_.Extension -match $AUDIO_PATTERN } | Sort-Object Name)
            foreach ($file in $files) {
                $rel = "bgm/$f/" + $file.FullName.Substring($dirFull.Length).TrimStart('\', '/').Replace('\', '/')
                if ($known.ContainsKey($rel)) {
                    [void]$new[$f].Add($known[$rel])
                    $known.Remove($rel)
                } else {
                    if (-not $reader) { $reader = New-MetaReader $Shared }
                    [void]$new[$f].Add((New-ScannedEntry $reader $file $rel))
                }
            }
        }
        Save-Manifest $Shared $new
        return $known.Count
    }

    function Invoke-Locked($Shared, [scriptblock]$Action) {
        [System.Threading.Monitor]::Enter($Shared.Lock)
        try { return (& $Action) } finally { [System.Threading.Monitor]::Exit($Shared.Lock) }
    }

    function Get-FolderPath($Shared, $Folder) {
        if ($FOLDERS -notcontains $Folder) { throw (New-Object System.ArgumentException "unknown folder: $Folder") }
        $dir = Join-Path $Shared.BgmDir $Folder
        if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
        return $dir
    }

    function Get-SafeFileName($Name) {
        $name = [System.IO.Path]::GetFileName([string]$Name)
        foreach ($c in [System.IO.Path]::GetInvalidFileNameChars()) { $name = $name.Replace([string]$c, '_') }
        if ([System.IO.Path]::GetExtension($name) -notmatch $AUDIO_PATTERN) { throw (New-Object System.ArgumentException "not an audio file: $Name") }
        return $name
    }

    function Get-UniqueName($Dir, $Name) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($Name)
        $ext = [System.IO.Path]::GetExtension($Name)
        $candidate = $Name
        for ($i = 1; Test-Path -LiteralPath (Join-Path $Dir $candidate); $i++) { $candidate = "$base ($i)$ext" }
        return $candidate
    }

    # --- HTTP ---
    function Read-Request($Stream) {
        $buf = New-Object byte[] 8192
        $ms = New-Object System.IO.MemoryStream
        $headerEnd = -1
        while ($headerEnd -lt 0) {
            $n = $Stream.Read($buf, 0, $buf.Length)
            if ($n -le 0) { return $null }
            $ms.Write($buf, 0, $n)
            if ($ms.Length -gt 65536) { return $null }
            $headerEnd = $LATIN1.GetString($ms.GetBuffer(), 0, [int]$ms.Length).IndexOf("`r`n`r`n")
        }
        $all = $ms.ToArray()
        $lines = $LATIN1.GetString($all, 0, $headerEnd) -split "`r`n"
        $first = $lines[0] -split ' '
        if ($first.Count -lt 3) { return $null }
        $headers = @{}
        foreach ($line in ($lines | Select-Object -Skip 1)) {
            $i = $line.IndexOf(':')
            if ($i -gt 0) { $headers[$line.Substring(0, $i).Trim().ToLowerInvariant()] = $line.Substring($i + 1).Trim() }
        }
        $target = $first[1]
        $qi = $target.IndexOf('?')
        $rawPath = if ($qi -ge 0) { $target.Substring(0, $qi) } else { $target }
        $query = @{}
        if ($qi -ge 0) {
            foreach ($pair in $target.Substring($qi + 1) -split '&') {
                if (-not $pair) { continue }
                $kv = $pair -split '=', 2
                $value = if ($kv.Count -gt 1) { [System.Uri]::UnescapeDataString($kv[1]) } else { '' }
                $query[[System.Uri]::UnescapeDataString($kv[0])] = $value
            }
        }
        $leftover = New-Object byte[] ($all.Length - $headerEnd - 4)
        [System.Array]::Copy($all, $headerEnd + 4, $leftover, 0, $leftover.Length)
        return @{
            Method = $first[0].ToUpperInvariant()
            Path = [System.Uri]::UnescapeDataString($rawPath)
            Query = $query
            Headers = $headers
            Leftover = $leftover
        }
    }

    function Get-ContentLength($Req) {
        $v = $Req.Headers['content-length']
        if (-not $v) { return [long]0 }
        return [long]$v
    }

    # 本文を少しずつ書き出す（曲全体をメモリに載せない）
    function Copy-Body($Stream, $Req, $Out) {
        $remaining = Get-ContentLength $Req
        $first = [long][Math]::Min($Req.Leftover.Length, $remaining)
        if ($first -gt 0) { $Out.Write($Req.Leftover, 0, [int]$first); $remaining -= $first }
        $buf = New-Object byte[] 65536
        while ($remaining -gt 0) {
            $n = $Stream.Read($buf, 0, [int][Math]::Min($buf.Length, $remaining))
            if ($n -le 0) { throw (New-Object System.IO.IOException 'connection closed while reading body') }
            $Out.Write($buf, 0, $n)
            $remaining -= $n
        }
    }

    function Read-BodyText($Stream, $Req) {
        if ((Get-ContentLength $Req) -gt 16MB) { throw (New-Object System.ArgumentException 'body too large') }
        $ms = New-Object System.IO.MemoryStream
        Copy-Body $Stream $Req $ms
        return $UTF8.GetString($ms.ToArray())
    }

    function Send-Head($Stream, $Status, $Reason, $ContentType, [long]$Length, $Extra) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append("HTTP/1.1 $Status $Reason`r`n")
        [void]$sb.Append("Content-Type: $ContentType`r`n")
        [void]$sb.Append("Content-Length: $Length`r`n")
        [void]$sb.Append("Cache-Control: no-store`r`n")
        [void]$sb.Append("X-Content-Type-Options: nosniff`r`n")
        [void]$sb.Append("Connection: close`r`n")
        if ($Extra) { foreach ($k in $Extra.Keys) { [void]$sb.Append("${k}: $($Extra[$k])`r`n") } }
        [void]$sb.Append("`r`n")
        $bytes = $LATIN1.GetBytes($sb.ToString())
        $Stream.Write($bytes, 0, $bytes.Length)
    }

    function Send-Bytes($Stream, $Req, $Status, $Reason, $ContentType, [byte[]]$Body) {
        Send-Head $Stream $Status $Reason $ContentType $Body.Length $null
        if ($Req.Method -ne 'HEAD' -and $Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    }

    function Send-Text($Stream, $Req, $Status, $Reason, $ContentType, $Text) {
        Send-Bytes $Stream $Req $Status $Reason $ContentType $UTF8.GetBytes([string]$Text)
    }

    function Send-Json($Stream, $Req, $Obj) {
        Send-Text $Stream $Req 200 'OK' 'application/json; charset=utf-8' (ConvertTo-Json -InputObject $Obj -Depth 6 -Compress)
    }

    function Send-Error($Stream, $Req, $Status, $Reason, $Message) {
        Send-Text $Stream $Req $Status $Reason 'application/json; charset=utf-8' (ConvertTo-Json -InputObject @{ error = [string]$Message } -Compress)
    }

    # 音声のシークに必要な Range 指定（bytes=開始-終了）に応える
    function Send-File($Stream, $Req, $Path) {
        $ext = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
        $type = $MIME[$ext]
        if (-not $type) { $type = 'application/octet-stream' }
        $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $len = $fs.Length
            $start = [long]0; $end = $len - 1
            $status = 200; $reason = 'OK'
            $extra = [ordered]@{ 'Accept-Ranges' = 'bytes' }
            $range = $Req.Headers['range']
            if ($range -and $range -match '^bytes=(\d*)-(\d*)$') {
                if ($Matches[1] -eq '') {
                    $start = [Math]::Max([long]0, $len - [long]$Matches[2])
                } else {
                    $start = [long]$Matches[1]
                    if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $len - 1) }
                }
                if ($start -ge $len -or $start -gt $end) {
                    Send-Head $Stream 416 'Range Not Satisfiable' $type 0 @{ 'Content-Range' = "bytes */$len" }
                    return
                }
                $status = 206; $reason = 'Partial Content'
                $extra['Content-Range'] = "bytes $start-$end/$len"
            }
            $count = [long]($end - $start + 1)
            Send-Head $Stream $status $reason $type $count $extra
            if ($Req.Method -eq 'HEAD') { return }
            [void]$fs.Seek($start, 'Begin')
            $buf = New-Object byte[] 65536
            while ($count -gt 0) {
                $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $count))
                if ($n -le 0) { break }
                $Stream.Write($buf, 0, $n)
                $count -= $n
            }
        } finally {
            $fs.Dispose()
        }
    }

    # 配信してよいファイルだけを返す。data/ や隠しファイル、フォルダの外は見せない
    function Resolve-StaticPath($Shared, $UrlPath) {
        $rel = $UrlPath.TrimStart('/')
        if ($rel -eq '') { $rel = 'index.html' }
        $segments = $rel -split '/'
        foreach ($s in $segments) { if ($s -eq '' -or $s.StartsWith('.')) { return $null } }
        if ($segments[0] -eq 'data') { return $null }
        $full = [System.IO.Path]::GetFullPath((Join-Path $Shared.Root ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)))
        $rootWithSep = $Shared.Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $full.StartsWith($rootWithSep, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return $null }
        return $full
    }

    # config.js はサーバーが組み立てる。data/ に保存した設定・プリセットと、OBS に登録する入口の場所を渡す
    function Get-ConfigScript($Shared) {
        $info = [ordered]@{
            port = $Shared.Port
            sourcePath = (Join-Path $Shared.Root 'local_obs.html')
            dockUrl = (Get-FileUrl (Join-Path $Shared.Root 'local_dock.html'))
        }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('window.clockServer = ' + (ConvertTo-Json -InputObject $info -Compress) + ";`n")
        $config = Read-TextFile (Join-Path $Shared.DataDir 'config.json')
        if ($config) {
            [void]$sb.Append("window.bgmClockConfig = $config;`n")
        } else {
            # 初回は配布物の config.js（既定のスケジュール）を使う
            $default = Read-TextFile (Join-Path $Shared.Root 'config.js')
            if ($default) { [void]$sb.Append("$default`n") }
        }
        $presets = Read-TextFile (Join-Path $Shared.DataDir 'presets.json')
        if (-not $presets) { $presets = 'null' }
        [void]$sb.Append("window.bgmClockPresets = $presets;`n")
        return $sb.ToString()
    }

    function Get-BgmUsage($Shared) {
        $sum = [long]0
        foreach ($f in @(Get-ChildItem -LiteralPath $Shared.BgmDir -File -Recurse -ErrorAction SilentlyContinue)) { $sum += $f.Length }
        return $sum
    }

    function Save-JsonBody($Stream, $Req, $Path) {
        $text = Read-BodyText $Stream $Req
        try { [void](ConvertFrom-Json $text) } catch { throw (New-Object System.ArgumentException 'invalid JSON') }
        Write-TextFile $Path $text
    }

    function Invoke-Api($Stream, $Req, $Shared, $Name) {
        $q = $Req.Query
        switch ("$($Req.Method) $Name") {
            'GET manifest' { Send-Json $Stream $Req (Invoke-Locked $Shared { Read-Manifest $Shared }); return }
            'GET usage' { Send-Json $Stream $Req @{ usage = (Get-BgmUsage $Shared) }; return }
            'POST rescan' {
                $removed = Invoke-Locked $Shared { Update-Manifest $Shared }
                Send-Json $Stream $Req @{ removed = $removed }
                return
            }
            'PUT config' {
                Invoke-Locked $Shared { Save-JsonBody $Stream $Req (Join-Path $Shared.DataDir 'config.json') }
                Send-Json $Stream $Req @{ ok = $true }
                return
            }
            'PUT presets' {
                Invoke-Locked $Shared { Save-JsonBody $Stream $Req (Join-Path $Shared.DataDir 'presets.json') }
                Send-Json $Stream $Req @{ ok = $true }
                return
            }
            'PUT files' {
                $folder = $q['folder']
                $dir = Get-FolderPath $Shared $folder
                $name = Get-SafeFileName $q['name']
                # 受け取りは一時ファイルに書き、終わってから名前を決めて置く（曲リストの走査には拾われない拡張子にする）
                $part = Join-Path $dir ('.upload-' + [guid]::NewGuid().ToString('N') + '.part')
                $out = [System.IO.File]::Create($part)
                try { Copy-Body $Stream $Req $out } catch { $out.Dispose(); Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; throw }
                $out.Dispose()
                $manifest = Invoke-Locked $Shared {
                    $final = Get-UniqueName $dir $name
                    Move-Item -LiteralPath $part -Destination (Join-Path $dir $final)
                    $artist = [string]$q['artist']; $title = [string]$q['title']
                    if (-not $title) { $parts = Split-TrackName $final; $artist = $parts[0]; $title = $parts[1] }
                    $m = Read-Manifest $Shared
                    [void]$m[$folder].Add((New-Entry $final "bgm/$folder/$final" $artist $title))
                    $sorted = @($m[$folder] | Sort-Object { $_.name })
                    $m[$folder] = New-Object System.Collections.ArrayList
                    foreach ($e in $sorted) { [void]$m[$folder].Add($e) }
                    Save-Manifest $Shared $m
                    $m
                }
                Send-Json $Stream $Req $manifest
                return
            }
            'DELETE files' {
                $folder = $q['folder']
                [void](Get-FolderPath $Shared $folder)
                $manifest = Invoke-Locked $Shared {
                    $m = Read-Manifest $Shared
                    $entry = $null
                    foreach ($e in $m[$folder]) { if ($e.name -eq $q['name']) { $entry = $e; break } }
                    if ($entry) {
                        $file = Join-Path $Shared.Root ($entry.path -replace '/', [System.IO.Path]::DirectorySeparatorChar)
                        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
                        $m[$folder].Remove($entry)
                        Save-Manifest $Shared $m
                    }
                    $m
                }
                Send-Json $Stream $Req $manifest
                return
            }
            'DELETE folder' {
                $folder = $q['folder']
                $dir = Get-FolderPath $Shared $folder
                $manifest = Invoke-Locked $Shared {
                    Get-ChildItem -LiteralPath $dir -Force | Remove-Item -Recurse -Force
                    $m = Read-Manifest $Shared
                    $m[$folder] = New-Object System.Collections.ArrayList
                    Save-Manifest $Shared $m
                    $m
                }
                Send-Json $Stream $Req $manifest
                return
            }
            'DELETE all' {
                $manifest = Invoke-Locked $Shared {
                    foreach ($f in $FOLDERS) {
                        $dir = Get-FolderPath $Shared $f
                        Get-ChildItem -LiteralPath $dir -Force | Remove-Item -Recurse -Force
                    }
                    $m = New-EmptyManifest
                    Save-Manifest $Shared $m
                    $m
                }
                Send-Json $Stream $Req $manifest
                return
            }
        }
        Send-Error $Stream $Req 404 'Not Found' "unknown api: $($Req.Method) $Name"
    }

    function Invoke-Client($Client, $Shared) {
        $Client.ReceiveTimeout = 30000
        $Client.SendTimeout = 60000
        $stream = $Client.GetStream()
        $req = Read-Request $stream
        if (-not $req) { return }

        # 他のサイトからこのサーバーを操作されないよう、宛先の名前を確かめる（DNS リバインディング対策）
        $hostHeader = [string]$req.Headers['host']
        if ($hostHeader -ne "127.0.0.1:$($Shared.Port)" -and $hostHeader -ne "localhost:$($Shared.Port)") {
            Send-Error $stream $req 403 'Forbidden' 'invalid host'
            return
        }

        try {
            if ($req.Path -eq '/api/ping.js') {
                Send-Text $stream $req 200 'OK' 'text/javascript; charset=utf-8' "window.clockPlayerPing = { port: $($Shared.Port) };"
                return
            }
            if ($req.Path.StartsWith('/api/')) {
                # 独自の見出しを求めると、他のサイトからの fetch は事前確認で止まる（この確認には応えない）
                if ($req.Headers['x-clockplayer'] -ne '1') {
                    Send-Error $stream $req 403 'Forbidden' 'missing X-ClockPlayer header'
                    return
                }
                Invoke-Api $stream $req $Shared $req.Path.Substring(5)
                return
            }
            if ($req.Method -ne 'GET' -and $req.Method -ne 'HEAD') {
                Send-Error $stream $req 405 'Method Not Allowed' 'method not allowed'
                return
            }
            if ($req.Path -eq '/config.js') {
                Send-Text $stream $req 200 'OK' 'text/javascript; charset=utf-8' (Get-ConfigScript $Shared)
                return
            }
            $path = Resolve-StaticPath $Shared $req.Path
            if (-not $path) {
                Send-Error $stream $req 404 'Not Found' 'not found'
                return
            }
            Send-File $stream $req $path
        } catch [System.ArgumentException] {
            Send-Error $stream $req 400 'Bad Request' $_.Exception.Message
        } catch [System.IO.IOException] {
            # 再生側が読み込みをやめて接続を閉じた
        } catch {
            try { Send-Error $stream $req 500 'Internal Server Error' $_.Exception.Message } catch { }
            throw
        }
    }
}

# --- 起動中のサーバーを調べる ---
function Get-RunningPort {
    if (-not (Test-Path -LiteralPath $PortFile)) { return $null }
    $text = [System.IO.File]::ReadAllText($PortFile)
    if ($text -notmatch '(\d+)') { return $null }
    $port = [int]$Matches[1]
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port/api/ping.js")
        $req.Timeout = 1500
        $res = $req.GetResponse()
        $body = (New-Object System.IO.StreamReader $res.GetResponseStream()).ReadToEnd()
        $res.Close()
        if ($body -match 'clockPlayerPing') { return $port }
    } catch {
        # 応答なし
    }
    return $null
}

function Show-Urls($Port, $Heading) {
    $dockUrl = Get-FileUrl (Join-Path $Root 'local_dock.html')
    Write-Host ''
    Write-Host "  $Heading" -ForegroundColor Green
    Write-Host ''
    Write-Host "  ブラウザ               http://127.0.0.1:$Port/"
    Write-Host "  ブラウザソース         $(Join-Path $Root 'local_obs.html')"
    Write-Host '                         （「ローカルファイル」にチェックを入れて選ぶ）'
    Write-Host "  カスタムブラウザドック $dockUrl"
    Write-Host ''
}

function Stop-RunningServer {
    if (-not (Test-Path -LiteralPath $PidFile)) {
        Write-Host 'Clock Player のサーバーは起動していません。'
        return
    }
    $serverPid = [int]([System.IO.File]::ReadAllText($PidFile).Trim())
    $proc = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match '^(powershell|pwsh)$') {
        Stop-Process -Id $serverPid -Force
        Write-Host 'Clock Player のサーバーを停止しました。'
    } else {
        Write-Host 'Clock Player のサーバーは起動していません。'
    }
    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

function Write-Log($Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    if ($Background) {
        try { [System.IO.File]::AppendAllText($LogFile, "$line`r`n") } catch { }
    } else {
        Write-Host $line -ForegroundColor DarkGray
    }
}

# --- 本体 ---
. $Common

if ($Stop) {
    Stop-RunningServer
    exit 0
}

foreach ($dir in @($DataDir, $BgmDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir) }
}

$running = Get-RunningPort
if ($running) {
    Show-Urls $running "Clock Player はすでに起動しています（ポート $running）"
    exit 0
}

# 初期設定のポートは data/server.json で変えられる。使用中なら続きの番号を順に試す
$basePort = $DefaultPort
if (Test-Path -LiteralPath $SettingsFile) {
    try {
        $settings = ConvertFrom-Json ([System.IO.File]::ReadAllText($SettingsFile))
        if ($settings.port) { $basePort = [int]$settings.port }
    } catch {
        Write-Host "data/server.json を読めませんでした。ポート $DefaultPort を使います。" -ForegroundColor Yellow
    }
} else {
    [System.IO.File]::WriteAllText($SettingsFile, "{ `"port`": $DefaultPort }`r`n")
}

$listener = $null
$port = 0
for ($p = $basePort; $p -lt $basePort + $PortAttempts; $p++) {
    try {
        $candidate = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $p)
        if ([System.Environment]::OSVersion.Platform -eq 'Win32NT') { $candidate.ExclusiveAddressUse = $true }
        $candidate.Start()
        $listener = $candidate
        $port = $p
        break
    } catch {
        # 使用中
    }
}
if (-not $listener) {
    Write-Host "ポート $basePort から $($basePort + $PortAttempts - 1) がすべて使用中のため、起動できませんでした。" -ForegroundColor Red
    Write-Host 'data/server.json の port を別の番号に変えてください。'
    exit 1
}

$Shared = [hashtable]::Synchronized(@{
    Root = (Get-Item -LiteralPath $Root).FullName
    DataDir = $DataDir
    BgmDir = $BgmDir
    Port = $port
    Lock = New-Object System.Object
})

[void](Update-Manifest $Shared)

[System.IO.File]::WriteAllText($PortFile, "window.clockPlayerPort = $port;`r`n")
[System.IO.File]::WriteAllText($PidFile, "$PID")

if (-not $Background) {
    $heading = "Clock Player を起動しました（ポート $port）"
    if ($port -ne $basePort) { $heading += "　※ポート $basePort が使用中のため変更" }
    Show-Urls $port $heading
    Write-Host '  このウィンドウを閉じると停止します。' -ForegroundColor Yellow
    Write-Host ''
}
Write-Log "started on port $port"

$pool = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, 32)
# 曲情報の読み取り（Shell.Application）はシングルスレッドアパートメントで動かす
if ([System.Environment]::OSVersion.Platform -eq 'Win32NT') { $pool.ApartmentState = 'STA' }
$pool.Open()

$handler = {
    param($Client, $Shared, $CommonText)
    try {
        . ([scriptblock]::Create($CommonText))
        Invoke-Client $Client $Shared
    } catch {
        "error: $($_.Exception.Message)"
    } finally {
        $Client.Close()
    }
}

$commonText = $Common.ToString()
$jobs = New-Object System.Collections.ArrayList

function Complete-Jobs([switch]$All) {
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
        $job = $jobs[$i]
        if (-not $All -and -not $job.Handle.IsCompleted) { continue }
        try {
            foreach ($line in $job.PowerShell.EndInvoke($job.Handle)) { if ($line) { Write-Log $line } }
        } catch {
            Write-Log "error: $($_.Exception.Message)"
        }
        $job.PowerShell.Dispose()
        $jobs.RemoveAt($i)
    }
}

try {
    while ($true) {
        $accept = $listener.AcceptTcpClientAsync()
        while (-not $accept.Wait(500)) { Complete-Jobs }
        $client = $accept.Result
        $ps = [System.Management.Automation.PowerShell]::Create()
        $ps.RunspacePool = $pool
        [void]$ps.AddScript($handler).AddArgument($client).AddArgument($Shared).AddArgument($commonText)
        [void]$jobs.Add(@{ PowerShell = $ps; Handle = $ps.BeginInvoke() })
        Complete-Jobs
    }
} finally {
    $listener.Stop()
    $pool.Close()
    if ((Test-Path -LiteralPath $PidFile) -and ([System.IO.File]::ReadAllText($PidFile).Trim() -eq "$PID")) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
    }
}
