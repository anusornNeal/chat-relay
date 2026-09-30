param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

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

function Result-Error([string]$Code) {
  return [pscustomobject]@{ ok = $false; error = $Code }
}

function Test-InteractiveSession {
  return [System.Windows.Forms.SystemInformation]::UserInteractive -and
    ([ChatRelayNative]::GetForegroundWindow() -ne [IntPtr]::Zero)
}

function Resolve-Screen($Monitor) {
  $screens = @([System.Windows.Forms.Screen]::AllScreens)
  if ($screens.Count -eq 0) { return $null }

  if ($null -eq $Monitor -or [string]$Monitor -eq "primary") {
    for ($i = 0; $i -lt $screens.Count; $i++) {
      if ($screens[$i].Primary) {
        return [pscustomobject]@{ screen = $screens[$i]; index = $i }
      }
    }
    return $null
  }

  if ([string]$Monitor -eq "secondary") {
    for ($i = 0; $i -lt $screens.Count; $i++) {
      if (-not $screens[$i].Primary) {
        return [pscustomobject]@{ screen = $screens[$i]; index = $i }
      }
    }
    return $null
  }

  $parsedIndex = 0
  if (-not [int]::TryParse([string]$Monitor, [ref]$parsedIndex)) { return $null }
  if ($parsedIndex -lt 0 -or $parsedIndex -ge $screens.Count) { return $null }
  return [pscustomobject]@{ screen = $screens[$parsedIndex]; index = $parsedIndex }
}

function Invoke-Screenshot($Payload) {
  if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) {
    return Result-Error "session_unavailable"
  }

  $resolved = Resolve-Screen $Payload.monitor
  if ($null -eq $resolved) { return Result-Error "monitor_not_found" }

  $screen = $resolved.screen
  $bounds = $screen.Bounds
  if ($bounds.Width -le 0 -or $bounds.Height -le 0) {
    return Result-Error "session_unavailable"
  }

  $source = $null
  try {
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
    if ($null -eq $codec) { return Result-Error "capture_failed" }

    $maxBytes = 32768
    $targetWidth = [Math]::Min($bounds.Width, 960)
    $targetHeight = [Math]::Max(1, [int][Math]::Round($bounds.Height * ($targetWidth / [double]$bounds.Width)))
    $qualities = @(58L, 42L, 30L, 22L)
    $bytes = $null
    $finalWidth = $targetWidth
    $finalHeight = $targetHeight

    for ($sizeAttempt = 0; $sizeAttempt -lt 3 -and $null -eq $bytes; $sizeAttempt++) {
      $resized = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
      $draw = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $draw.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
        $draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $draw.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighSpeed
        $draw.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighSpeed
        $draw.DrawImage($source, 0, 0, $targetWidth, $targetHeight)
      } finally {
        $draw.Dispose()
      }

      try {
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
      } finally {
        $resized.Dispose()
      }

      if ($null -eq $bytes) {
        $targetWidth = [Math]::Max(320, [int][Math]::Floor($targetWidth * 0.78))
        $targetHeight = [Math]::Max(180, [int][Math]::Round($bounds.Height * ($targetWidth / [double]$bounds.Width)))
      }
    }

    if ($null -eq $bytes) { return Result-Error "screenshot_too_large" }

    return [pscustomobject]@{
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
      monitorIndex = $resolved.index
      isPrimary = [bool]$screen.Primary
      deviceName = [string]$screen.DeviceName
      byteLength = $bytes.Length
    }
  } catch {
    return Result-Error "capture_failed"
  } finally {
    if ($null -ne $source) { $source.Dispose() }
  }
}

function Invoke-MouseClick($Payload) {
  if (-not (Test-InteractiveSession)) { return Result-Error "session_unavailable" }

  $x = [int]$Payload.x
  $y = [int]$Payload.y
  $containsPoint = $false
  foreach ($screen in @([System.Windows.Forms.Screen]::AllScreens)) {
    if ($screen.Bounds.Contains($x, $y)) {
      $containsPoint = $true
      break
    }
  }
  if (-not $containsPoint) { return Result-Error "invalid_coordinates" }

  switch ([string]$Payload.button) {
    "left" { $down = 0x0002; $up = 0x0004 }
    "right" { $down = 0x0008; $up = 0x0010 }
    "middle" { $down = 0x0020; $up = 0x0040 }
    default { return Result-Error "invalid_button" }
  }

  if (-not [ChatRelayNative]::SetCursorPos($x, $y)) { return Result-Error "input_failed" }

  $clicks = [int]$Payload.clicks
  for ($i = 0; $i -lt $clicks; $i++) {
    if (-not [ChatRelayNative]::MouseButton($down, $up)) { return Result-Error "input_failed" }
    if ($i + 1 -lt $clicks) { Start-Sleep -Milliseconds 100 }
  }

  return [pscustomobject]@{ ok = $true; action = "mouse_click" }
}

function Invoke-KeyboardInput($Payload) {
  if (-not (Test-InteractiveSession)) { return Result-Error "session_unavailable" }

  if ($null -ne $Payload.text) {
    if (-not [ChatRelayNative]::UnicodeText([string]$Payload.text)) {
      return Result-Error "input_failed"
    }
  } else {
    $mods = New-Object System.Collections.Generic.List[uint16]
    if ($Payload.ctrl) { $mods.Add(0x11) }
    if ($Payload.alt) { $mods.Add(0x12) }
    if ($Payload.shift) { $mods.Add(0x10) }
    if ($Payload.win) { $mods.Add(0x5B) }

    foreach ($vk in $mods) {
      if (-not [ChatRelayNative]::Key($vk, $true)) { return Result-Error "input_failed" }
    }

    try {
      $keyCode = [uint16]$Payload.keyCode
      if (-not [ChatRelayNative]::Key($keyCode, $true)) { return Result-Error "input_failed" }
      if (-not [ChatRelayNative]::Key($keyCode, $false)) { return Result-Error "input_failed" }
    } finally {
      for ($i = $mods.Count - 1; $i -ge 0; $i--) {
        [ChatRelayNative]::Key($mods[$i], $false) | Out-Null
      }
    }
  }

  return [pscustomobject]@{ ok = $true; action = "keyboard_input" }
}

function Invoke-Step($Payload) {
  $completed = 0
  foreach ($action in @($Payload.actions)) {
    $result = $null
    switch ([string]$action.type) {
      "click" { $result = Invoke-MouseClick $action }
      "text" { $result = Invoke-KeyboardInput $action }
      "key" { $result = Invoke-KeyboardInput $action }
      "wait" {
        Start-Sleep -Milliseconds ([int]$action.ms)
        $result = [pscustomobject]@{ ok = $true; action = "wait" }
      }
      default { $result = Result-Error "invalid_step_action" }
    }

    if (-not $result.ok) {
      return [pscustomobject]@{
        ok = $false
        error = $result.error
        actionsCompleted = $completed
      }
    }
    $completed++
  }

  if ([int]$Payload.settleMs -gt 0) {
    Start-Sleep -Milliseconds ([int]$Payload.settleMs)
  }

  if ($Payload.captureAfter -eq $false) {
    return [pscustomobject]@{
      ok = $true
      action = "step"
      actionsCompleted = $completed
    }
  }

  $shotPayload = [pscustomobject]@{ monitor = $Payload.monitor }
  $shot = Invoke-Screenshot $shotPayload
  if (-not $shot.ok) {
    return [pscustomobject]@{
      ok = $false
      error = $shot.error
      actionsCompleted = $completed
    }
  }

  $shot | Add-Member -NotePropertyName action -NotePropertyValue "step" -Force
  $shot | Add-Member -NotePropertyName actionsCompleted -NotePropertyValue $completed -Force
  return $shot
}

function Invoke-Operation([string]$Operation, $Payload) {
  switch ($Operation) {
    "screenshot" { return Invoke-Screenshot $Payload }
    "mouse_click" { return Invoke-MouseClick $Payload }
    "keyboard_input" { return Invoke-KeyboardInput $Payload }
    "step" { return Invoke-Step $Payload }
    default { return Result-Error "unknown_desktop_operation" }
  }
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = $null
  $result = $null
  try {
    $request = $line | ConvertFrom-Json
    $id = [string]$request.id
    $result = Invoke-Operation ([string]$request.operation) $request.args
  } catch {
    $result = Result-Error "desktop_worker_error"
  }

  $response = [pscustomobject]@{
    id = $id
    result = $result
  }

  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()
}
