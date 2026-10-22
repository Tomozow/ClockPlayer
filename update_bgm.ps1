$batchDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bgmDir = Join-Path $batchDir 'bgm'
$manifestPath = Join-Path $batchDir 'bgm_manifest.js'

if (!(Test-Path $bgmDir)) {
    New-Item -ItemType Directory -Path $bgmDir | Out-Null
}

# Initialize COM object for metadata retrieval
$shell = New-Object -ComObject Shell.Application

# Set robust default index values for Japanese/English Windows environments
$artistIdx = 13      # Default "Contributing artists" or "Authors"
$albumArtistIdx = 186 # Default "Album artist"
$titleIdx = 21       # Default "Title"

$subDir = Get-ChildItem -Path $bgmDir -Directory | Select-Object -First 1
$tempFolder = $null
if ($subDir) {
    $tempFolder = $shell.NameSpace($subDir.FullName)
}
if (!$tempFolder) {
    $tempFolder = $shell.NameSpace($bgmDir)
}

# Define multibyte Japanese characters via Unicode points with -join to avoid space-padding cast issues
# "Artist" (ア ー テ ィ ス ト)
$headArtist1 = -join @(0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8 | ForEach-Object { [char]$_ })
# "Contributing Artist" (参 加 アーティスト)
$headArtist2 = -join @(0x53C2, 0x52A0, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8 | ForEach-Object { [char]$_ })
# "Album Artist" (ア ル バ ム 　 アーティスト)
$headArtist3 = -join @(0x30A2, 0x30EB, 0x30D0, 0x30E0, 0x3000, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8 | ForEach-Object { [char]$_ }) # with space
$headArtist4 = -join @(0x30A2, 0x30EB, 0x30D0, 0x30E0, 0x30A2, 0x30FC, 0x30C6, 0x30A3, 0x30B9, 0x30C8 | ForEach-Object { [char]$_ }) # without space
# "Title" (タ イ ト ル)
$headTitle = -join @(0x30BF, 0x30A4, 0x30C8, 0x30EB | ForEach-Object { [char]$_ })

if ($tempFolder) {
    for ($i = 0; $i -lt 300; $i++) {
        $name = $tempFolder.GetDetailsOf($null, $i)
        if ($name -eq 'Contributing artists' -or $name -eq $headArtist1 -or $name -eq $headArtist2 -or $name -eq 'Authors' -or $name -eq 'Artist') {
            $artistIdx = $i
        }
        if ($name -eq 'Album artist' -or $name -eq $headArtist3 -or $name -eq $headArtist4 -or $name -eq 'AlbumArtist') {
            $albumArtistIdx = $i
        }
        if ($name -eq 'Title' -or $name -eq $headTitle) {
            $titleIdx = $i
        }
    }
}


$folders = @('bgmA', 'bgmB', 'bgmC', 'bgmD', 'bgmE', 'bgmF')
$manifest = @{}

foreach ($folder in $folders) {
    $folderPath = Join-Path $bgmDir $folder
    if (!(Test-Path $folderPath)) {
        New-Item -ItemType Directory -Path $folderPath | Out-Null
    }
    
    $files = Get-ChildItem -Path $folderPath -File -Recurse | Where-Object { $_.Extension -match '^\.(mp3|wav|ogg|m4a|aac|flac)$' }
    $relativePaths = @()
    
    foreach ($file in $files) {
        $absPath = $file.FullName
        $rootAbsPath = (Get-Item $batchDir).FullName
        if ($absPath.StartsWith($rootAbsPath)) {
            $relPath = $absPath.Substring($rootAbsPath.Length).TrimStart('\').TrimStart('/')
            $relPath = $relPath -replace '\\', '/'
            
            $artist = ''
            $title = ''
            $baseName = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
            
            # 1. Try to extract Artist and Title from file name "Artist - Title"
            if ($baseName -match '^(.+?)\s*-\s*(.+)$') {
                $artist = $Matches[1].Trim()
                $title = $Matches[2].Trim()
            } else {
                $title = $baseName
            }
            
            # 2. If artist is empty, try to get from COM metadata
            if ([string]::IsNullOrWhiteSpace($artist)) {
                try {
                    $fileFolder = $shell.NameSpace($file.DirectoryName)
                    $fileItem = $fileFolder.ParseName($file.Name)
                    
                    if ($artistIdx -ne -1) {
                        $metaArtist = $fileFolder.GetDetailsOf($fileItem, $artistIdx)
                        if (![string]::IsNullOrWhiteSpace($metaArtist)) {
                            $artist = $metaArtist.Trim()
                        }
                    }
                    
                    if ([string]::IsNullOrWhiteSpace($artist) -and $albumArtistIdx -ne -1) {
                        $metaAlbumArtist = $fileFolder.GetDetailsOf($fileItem, $albumArtistIdx)
                        if (![string]::IsNullOrWhiteSpace($metaAlbumArtist)) {
                            $artist = $metaAlbumArtist.Trim()
                        }
                    }
                    
                    if ($title -eq $baseName -and $titleIdx -ne -1) {
                        $metaTitle = $fileFolder.GetDetailsOf($fileItem, $titleIdx)
                        if (![string]::IsNullOrWhiteSpace($metaTitle)) {
                            $title = $metaTitle.Trim()
                        }
                    }
                } catch {
                    # Ignore errors
                }
            }
            
            # Use PSObject for backward compatibility with older PowerShell versions
            $item = New-Object PSObject
            $item | Add-Member -MemberType NoteProperty -Name "name" -Value $file.Name
            $item | Add-Member -MemberType NoteProperty -Name "path" -Value $relPath
            $item | Add-Member -MemberType NoteProperty -Name "artist" -Value $artist
            $item | Add-Member -MemberType NoteProperty -Name "title" -Value $title
            $relativePaths += $item
        }
    }
    $manifest[$folder] = $relativePaths
}

$json = ConvertTo-Json $manifest -Depth 5
$jsContent = 'window.bgmManifest = ' + $json + ';'
[System.IO.File]::WriteAllText($manifestPath, $jsContent, [System.Text.Encoding]::UTF8)

Write-Host 'BGM Manifest updated successfully! (bgm_manifest.js)' -ForegroundColor Green
