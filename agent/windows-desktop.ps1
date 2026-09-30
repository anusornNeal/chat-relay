param(
  [Parameter(Mandatory=$true)][string]$Operation,
  [Parameter(Mandatory=$true)][string]$InputBase64
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Result($Value) {
  $Value | ConvertTo-Json -Compress -Depth 8
}

function Fail($Code) {
  Write-Result ([pscustomobject]@{ ok = $false; error = $Code })
  exit 0
}

try {
  $inputJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($InputBase64))
  $payload = if ($inputJson) { $inputJson | ConvertFrom-Json } else { [pscustomobject]@{} }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class ChatRelayNative {
  public const uint INPUT_MOUSE = 0;
  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const uint KEYEVENTF_UNICODE = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public UIntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public INPUTUNION U;
  }

  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

  public static bool MouseButton(uint downFlag, uint upFlag) {
    var inputs = new INPUT[2];
    inputs[0].type = INPUT_MOUSE;
    inputs[0].U.mi.dwFlags = downFlag;
    inputs[1].type = INPUT_MOUSE;
    inputs[1].U.mi.dwFlags = upFlag;
    return SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) == 2;
  }

  public static bool Key(ushort virtualKey, bool down) {
    var input = new INPUT[1];
    input[0].type = INPUT_KEYBOARD;
    input[0].U.ki.wVk = virtualKey;
    input[0].U.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
    return SendInput(1, input, Marshal.SizeOf(typeof(INPUT))) == 1;
  }

  public static bool UnicodeText(string text) {
    foreach (char c in text) {
      var inputs = new INPUT[2];
      inputs[0].type = INPUT_KEYBOARD;
      inputs[0].U.ki.wScan = c;
      inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
      inputs[1].type = INPUT_KEYBOARD;
      inputs[1].U.ki.wScan = c;
      inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
      if (SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) return false;
    }
    return true;
  }
}
"@

  [ChatRelayNative]::SetProcessDPIAware() | Out-Null
  if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) {
    Fail "session_unavailable"
  }

  if ($Operation -eq "screenshot") {
    $screens = @([System.Windows.Forms.Screen]::AllScreens)
    if ($screens.Count -eq 0) { Fail "session_unavailable" }

    $monitor = if ($null -ne $payload.monitor) { $payload.monitor } else { "primary" }
    $screen = $null
    $monitorIndex = -1

    if ([string]$monitor -eq "primary") {
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      for ($i = 0; $i -lt $screens.Count; $i++) { if ($screens[$i].Primary) { $monitorIndex = $i; break } }
    } elseif ([string]$monitor -eq "secondary") {
      for ($i = 0; $i -lt $screens.Count; $i++) {
        if (-not $screens[$i].Primary) { $screen = $screens[$i]; $monitorIndex = $i; break }
      }
      if ($null -eq $screen) { Fail "monitor_not_found" }
    } else {
      $parsedIndex = 0
      if (-not [int]::TryParse([string]$monitor, [ref]$parsedIndex)) { Fail "invalid_monitor" }
      if ($parsedIndex -lt 0 -or $parsedIndex -ge $screens.Count) { Fail "monitor_not_found" }
      $screen = $screens[$parsedIndex]
      $monitorIndex = $parsedIndex
    }

    if ($null -eq $screen) { Fail "session_unavailable" }
    $bounds = $screen.Bounds
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { Fail "session_unavailable" }

    $source = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($source)
    try {
      $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    } finally {
      $graphics.Dispose()
    }

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq "image/jpeg" } |
      Select-Object -First 1
    if ($null -eq $codec) {
      $source.Dispose()
      Fail "capture_failed"
    }

    $maxBytes = 32768
    $targetWidth = [Math]::Min($bounds.Width, 960)
    $scale = $targetWidth / [double]$bounds.Width
    $targetHeight = [Math]::Max(1, [int][Math]::Round($bounds.Height * $scale))
    $qualities = @(70L, 55L, 42L, 32L, 24L)
    $bytes = $null
    $finalWidth = $targetWidth
    $finalHeight = $targetHeight

    for ($sizeAttempt = 0; $sizeAttempt -lt 4 -and $null -eq $bytes; $sizeAttempt++) {
      $resized = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
      $draw = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $draw.DrawImage($source, 0, 0, $targetWidth, $targetHeight)
      } finally {
        $draw.Dispose()
      }

      foreach ($quality in $qualities) {
        $stream = New-Object System.IO.MemoryStream
        $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
        $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
          [System.Drawing.Imaging.Encoder]::Quality,
          $quality
        )
        try {
          $resized.Save($stream, $codec, $parameters)
          if ($stream.Length -le $maxBytes) {
            $bytes = $stream.ToArray()
            $finalWidth = $targetWidth
            $finalHeight = $targetHeight
            break
          }
        } finally {
          $parameters.Dispose()
          $stream.Dispose()
        }
      }

      $resized.Dispose()
      if ($null -eq $bytes) {
        $targetWidth = [Math]::Max(320, [int][Math]::Floor($targetWidth * 0.78))
        $targetHeight = [Math]::Max(180, [int][Math]::Round($bounds.Height * ($targetWidth / [double]$bounds.Width)))
      }
    }

    $source.Dispose()
    if ($null -eq $bytes) { Fail "screenshot_too_large" }

    Write-Result ([pscustomobject]@{
      ok = $true
      mimeType = "image/jpeg"
      data = [Convert]::ToBase64String($bytes)
      width = $finalWidth
      height = $finalHeight
      desktopOriginX = $bounds.Left
      desktopOriginY = $bounds.Top
      desktopWidth = $bounds.Width
      desktopHeight = $bounds.Height
      scaleX = $bounds.Width / [double]$finalWidth
      scaleY = $bounds.Height / [double]$finalHeight
      monitorIndex = $monitorIndex
      isPrimary = [bool]$screen.Primary
      deviceName = [string]$screen.DeviceName
      byteLength = $bytes.Length
    })
    exit 0
  }

  if ([ChatRelayNative]::GetForegroundWindow() -eq [IntPtr]::Zero) {
    Fail "session_unavailable"
  }

  if ($Operation -eq "mouse_click") {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen
    if ($null -eq $screen) { Fail "session_unavailable" }
    $bounds = $screen.Bounds
    $x = [int]$payload.x
    $y = [int]$payload.y
    if ($x -lt $bounds.Left -or $x -ge $bounds.Right -or $y -lt $bounds.Top -or $y -ge $bounds.Bottom) {
      Fail "invalid_coordinates"
    }

    switch ([string]$payload.button) {
      "left" { $down = 0x0002; $up = 0x0004 }
      "right" { $down = 0x0008; $up = 0x0010 }
      "middle" { $down = 0x0020; $up = 0x0040 }
      default { Fail "invalid_button" }
    }

    if (-not [ChatRelayNative]::SetCursorPos($x, $y)) { Fail "input_failed" }
    $clicks = [int]$payload.clicks
    for ($i = 0; $i -lt $clicks; $i++) {
      if (-not [ChatRelayNative]::MouseButton($down, $up)) { Fail "input_failed" }
      if ($i + 1 -lt $clicks) { Start-Sleep -Milliseconds 100 }
    }

    Write-Result ([pscustomobject]@{ ok = $true; action = "mouse_click" })
    exit 0
  }

  if ($Operation -eq "keyboard_input") {
    if ($null -ne $payload.text) {
      if (-not [ChatRelayNative]::UnicodeText([string]$payload.text)) { Fail "input_failed" }
    } else {
      $mods = New-Object System.Collections.Generic.List[uint16]
      if ($payload.ctrl) { $mods.Add(0x11) }
      if ($payload.alt) { $mods.Add(0x12) }
      if ($payload.shift) { $mods.Add(0x10) }
      if ($payload.win) { $mods.Add(0x5B) }

      foreach ($vk in $mods) {
        if (-not [ChatRelayNative]::Key($vk, $true)) { Fail "input_failed" }
      }
      try {
        $keyCode = [uint16]$payload.keyCode
        if (-not [ChatRelayNative]::Key($keyCode, $true)) { Fail "input_failed" }
        if (-not [ChatRelayNative]::Key($keyCode, $false)) { Fail "input_failed" }
      } finally {
        for ($i = $mods.Count - 1; $i -ge 0; $i--) {
          [ChatRelayNative]::Key($mods[$i], $false) | Out-Null
        }
      }
    }

    Write-Result ([pscustomobject]@{ ok = $true; action = "keyboard_input" })
    exit 0
  }

  Fail "unknown_desktop_operation"
} catch {
  $message = [string]$_.Exception.Message
  if ($message -match "session_unavailable") { Fail "session_unavailable" }
  if ($Operation -eq "screenshot") { Fail "capture_failed" }
  Fail "input_failed"
}
