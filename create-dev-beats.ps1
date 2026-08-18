$beatsDir = "E:\777\app\beatvault\dev-beats"

$beats = @(
    @{ name = "Trap King"; bpm = "140"; key = "C Minor" },
    @{ name = "Drill Vibe"; bpm = "95"; key = "A Minor" },
    @{ name = "LoFi Chill"; bpm = "85"; key = "F Major" },
    @{ name = "Boom Bap"; bpm = "100"; key = "E Minor" },
    @{ name = "Hardtrap"; bpm = "175"; key = "G Minor" },
    @{ name = "Jazz Hop"; bpm = "110"; key = "Bb Major" },
    @{ name = "Ambient Beat"; bpm = "70"; key = "D Minor" },
    @{ name = "Future Bass"; bpm = "128"; key = "F Major" }
)

function Create-FakeMP3 {
    param([string]$Path)
    
    $id3Header = [byte[]]@(
        0x49, 0x44, 0x33,
        0x03, 0x00,
        0x00,
        0x00, 0x00, 0x00, 0x00
    )
    
    $mp3Frame = [byte[]]@(
        0xFF, 0xFB,
        0x90, 0x00
    )
    
    $combined = $id3Header + $mp3Frame
    [System.IO.File]::WriteAllBytes($Path, $combined)
}

if (Test-Path $beatsDir) {
    Remove-Item $beatsDir -Recurse -Force
}
New-Item -ItemType Directory -Path $beatsDir | Out-Null

foreach ($beat in $beats) {
    $beatFolder = Join-Path $beatsDir $beat.name
    New-Item -ItemType Directory -Path $beatFolder | Out-Null
    
    $mp3Path = Join-Path $beatFolder "$($beat.name).mp3"
    Create-FakeMP3 -Path $mp3Path
    
    $infoPath = Join-Path $beatFolder "info.txt"
    $info = "Name: $($beat.name)`r`nBPM: $($beat.bpm)`r`nKey: $($beat.key)`r`nCreated: $(Get-Date)"
    [System.IO.File]::WriteAllText($infoPath, $info)
    
    Write-Host "Created beat: $($beat.name) ($($beat.bpm) BPM, $($beat.key))"
}

Write-Host "Dev beats folder ready at: $beatsDir"
