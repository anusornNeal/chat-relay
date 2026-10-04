param()

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

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

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  public sealed class WindowInfo {
    public string WindowId;
    public uint ProcessId;
    public string Title;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool IsForeground;
  }

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);

  public static WindowInfo[] ListWindows(int limit) {
    var items = new List<WindowInfo>();
    var foreground = GetForegroundWindow();
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      if (items.Count >= limit) return false;
      if (!IsWindowVisible(hWnd)) return true;
      int titleLength = GetWindowTextLength(hWnd);
      if (titleLength <= 0) return true;
      var title = new StringBuilder(titleLength + 1);
      if (GetWindowText(hWnd, title, title.Capacity) <= 0) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) return true;
      items.Add(new WindowInfo {
        WindowId = unchecked((ulong)hWnd.ToInt64()).ToString(),
        ProcessId = pid,
        Title = title.ToString(),
        X = rect.Left,
        Y = rect.Top,
        Width = Math.Max(0, rect.Right - rect.Left),
        Height = Math.Max(0, rect.Bottom - rect.Top),
        IsForeground = hWnd == foreground,
      });
      return true;
    }, IntPtr.Zero);
    return items.ToArray();
  }

  public static bool FocusWindow(string windowId) {
    ulong raw;
    if (!UInt64.TryParse(windowId, out raw) || raw == 0) return false;
    var hWnd = new IntPtr(unchecked((long)raw));
    if (!IsWindow(hWnd)) return false;
    ShowWindowAsync(hWnd, 9);
    return SetForegroundWindow(hWnd);
  }

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
  $totalTimer = [System.Diagnostics.Stopwatch]::StartNew()
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
    $captureTimer = [System.Diagnostics.Stopwatch]::StartNew()
    try {
      $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
    } finally {
      $captureTimer.Stop()
      $graphics.Dispose()
    }
    $captureMs = [int][Math]::Round($captureTimer.Elapsed.TotalMilliseconds)
    $encodeTimer = [System.Diagnostics.Stopwatch]::StartNew()

    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
      Where-Object { $_.MimeType -eq "image/jpeg" } |
      Select-Object -First 1
    if ($null -eq $codec) { return Result-Error "capture_failed" }

    $native = $Payload.native -eq $true
    $maxBytes = if ($native) { 2097152 } else { 32768 }
    $requestedMaxWidth = if ($null -eq $Payload.maxWidth) { 960 } else { [int]$Payload.maxWidth }
    if (-not $native -and ($requestedMaxWidth -lt 320 -or $requestedMaxWidth -gt 1920)) { return Result-Error "invalid_max_width" }
    $requestedQuality = if ($null -eq $Payload.quality) { 58 } else { [int]$Payload.quality }
    if ($requestedQuality -lt 20 -or $requestedQuality -gt 85) { return Result-Error "invalid_quality" }
    $targetWidth = if ($native) { $bounds.Width } else { [Math]::Min($bounds.Width, $requestedMaxWidth) }
    $targetHeight = [Math]::Max(1, [int][Math]::Round($bounds.Height * ($targetWidth / [double]$bounds.Width)))
    $qualities = if ($native) {
      @([long]$requestedQuality, 75L, 60L, 45L, 30L, 20L) | Where-Object { $_ -le $requestedQuality } | Select-Object -Unique
    } else {
      @([long]$requestedQuality, [long][Math]::Min($requestedQuality, 42), [long][Math]::Min($requestedQuality, 30), 20L) | Select-Object -Unique
    }
    $bytes = $null
    $finalWidth = $targetWidth
    $finalHeight = $targetHeight
    $finalQuality = $requestedQuality

    $maxSizeAttempts = if ($native) { 1 } else { 3 }
    for ($sizeAttempt = 0; $sizeAttempt -lt $maxSizeAttempts -and $null -eq $bytes; $sizeAttempt++) {
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
              $finalQuality = [int]$quality
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
    $base64 = [Convert]::ToBase64String($bytes)
    $encodeTimer.Stop()
    $totalTimer.Stop()
    $virtualBounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $monitorCount = @([System.Windows.Forms.Screen]::AllScreens).Count

    return [pscustomobject]@{
      ok = $true
      mimeType = "image/jpeg"
      data = $base64
      width = $finalWidth
      height = $finalHeight
      virtualDesktopOriginX = $virtualBounds.Left
      virtualDesktopOriginY = $virtualBounds.Top
      virtualDesktopWidth = $virtualBounds.Width
      virtualDesktopHeight = $virtualBounds.Height
      monitorCount = $monitorCount
      jpegQuality = $finalQuality
      native = $native
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
      timing = [pscustomobject]@{
        captureMs = $captureMs
        encodeMs = [int][Math]::Round($encodeTimer.Elapsed.TotalMilliseconds)
        screenshotTotalMs = [int][Math]::Round($totalTimer.Elapsed.TotalMilliseconds)
      }
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

function Invoke-ClipboardRead($Payload) {
  if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) { return Result-Error "session_unavailable" }
  try {
    $text = if ([System.Windows.Forms.Clipboard]::ContainsText()) { [System.Windows.Forms.Clipboard]::GetText() } else { "" }
    $truncated = $text.Length -gt 8192
    if ($truncated) { $text = $text.Substring(0, 8192) }
    return [pscustomobject]@{ ok = $true; text = $text; truncated = $truncated }
  } catch { return Result-Error "clipboard_failed" }
}

function Invoke-ClipboardWrite($Payload) {
  if (-not (Test-InteractiveSession)) { return Result-Error "session_unavailable" }
  try {
    $text = [string]$Payload.text
    if ($text.Length -gt 8192) { return Result-Error "text_too_large" }
    if ($text.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() } else { [System.Windows.Forms.Clipboard]::SetText($text) }
    return [pscustomobject]@{ ok = $true; action = "clipboard_write"; length = $text.Length }
  } catch { return Result-Error "clipboard_failed" }
}

function Invoke-WindowList($Payload) {
  if (-not [System.Windows.Forms.SystemInformation]::UserInteractive) { return Result-Error "session_unavailable" }
  $limit = if ($null -eq $Payload.limit) { 50 } else { [int]$Payload.limit }
  if ($limit -lt 1 -or $limit -gt 100) { return Result-Error "invalid_window_limit" }
  try {
    $windows = @([ChatRelayNative]::ListWindows($limit))
    return [pscustomobject]@{ ok = $true; windows = $windows; count = $windows.Count }
  } catch { return Result-Error "window_list_failed" }
}

function Invoke-WindowFocus($Payload) {
  if (-not (Test-InteractiveSession)) { return Result-Error "session_unavailable" }
  $windowId = [string]$Payload.windowId
  if ($windowId -notmatch '^[1-9][0-9]{0,19}$') { return Result-Error "invalid_window_id" }
  try {
    if (-not [ChatRelayNative]::FocusWindow($windowId)) { return Result-Error "focus_failed" }
    return [pscustomobject]@{ ok = $true; action = "window_focus"; windowId = $windowId }
  } catch { return Result-Error "focus_failed" }
}

function Invoke-Step($Payload) {
  $totalTimer = [System.Diagnostics.Stopwatch]::StartNew()
  $completed = 0
  $inputMs = 0
  $explicitWaitMs = 0
  $settleMs = 0

  foreach ($action in @($Payload.actions)) {
    $result = $null
    if ([string]$action.type -eq "wait") {
      $waitTimer = [System.Diagnostics.Stopwatch]::StartNew()
      Start-Sleep -Milliseconds ([int]$action.ms)
      $waitTimer.Stop()
      $explicitWaitMs += [int][Math]::Round($waitTimer.Elapsed.TotalMilliseconds)
      $result = [pscustomobject]@{ ok = $true; action = "wait" }
    } else {
      $inputTimer = [System.Diagnostics.Stopwatch]::StartNew()
      switch ([string]$action.type) {
        "click" { $result = Invoke-MouseClick $action }
        "text" { $result = Invoke-KeyboardInput $action }
        "key" { $result = Invoke-KeyboardInput $action }
        default { $result = Result-Error "invalid_step_action" }
      }
      $inputTimer.Stop()
      $inputMs += [int][Math]::Round($inputTimer.Elapsed.TotalMilliseconds)
    }

    if (-not $result.ok) {
      $totalTimer.Stop()
      return [pscustomobject]@{
        ok = $false
        error = $result.error
        actionsCompleted = $completed
        timing = [pscustomobject]@{
          inputMs = $inputMs
          explicitWaitMs = $explicitWaitMs
          settleMs = $settleMs
          captureMs = 0
          encodeMs = 0
          workerMs = [int][Math]::Round($totalTimer.Elapsed.TotalMilliseconds)
        }
      }
    }

    $completed++
    $actionSettleMs = [int]$action.settleAfterMs
    if ($actionSettleMs -gt 0) {
      $settleTimer = [System.Diagnostics.Stopwatch]::StartNew()
      Start-Sleep -Milliseconds $actionSettleMs
      $settleTimer.Stop()
      $settleMs += [int][Math]::Round($settleTimer.Elapsed.TotalMilliseconds)
    }
  }

  if ([int]$Payload.settleMs -gt 0) {
    $finalSettleTimer = [System.Diagnostics.Stopwatch]::StartNew()
    Start-Sleep -Milliseconds ([int]$Payload.settleMs)
    $finalSettleTimer.Stop()
    $settleMs += [int][Math]::Round($finalSettleTimer.Elapsed.TotalMilliseconds)
  }

  if ($Payload.captureAfter -ne $true) {
    $totalTimer.Stop()
    return [pscustomobject]@{
      ok = $true
      action = "step"
      actionsCompleted = $completed
      timing = [pscustomobject]@{
        inputMs = $inputMs
        explicitWaitMs = $explicitWaitMs
        settleMs = $settleMs
        captureMs = 0
        encodeMs = 0
        workerMs = [int][Math]::Round($totalTimer.Elapsed.TotalMilliseconds)
      }
    }
  }

  $shotPayload = [pscustomobject]@{ monitor = $Payload.monitor; maxWidth = $Payload.maxWidth; quality = $Payload.quality }
  $shot = Invoke-Screenshot $shotPayload
  if (-not $shot.ok) {
    $totalTimer.Stop()
    return [pscustomobject]@{
      ok = $false
      error = $shot.error
      actionsCompleted = $completed
      timing = [pscustomobject]@{
        inputMs = $inputMs
        explicitWaitMs = $explicitWaitMs
        settleMs = $settleMs
        captureMs = 0
        encodeMs = 0
        workerMs = [int][Math]::Round($totalTimer.Elapsed.TotalMilliseconds)
      }
    }
  }

  $totalTimer.Stop()
  $captureMs = if ($null -ne $shot.timing) { [int]$shot.timing.captureMs } else { 0 }
  $encodeMs = if ($null -ne $shot.timing) { [int]$shot.timing.encodeMs } else { 0 }
  $shot | Add-Member -NotePropertyName action -NotePropertyValue "step" -Force
  $shot | Add-Member -NotePropertyName actionsCompleted -NotePropertyValue $completed -Force
  $shot | Add-Member -NotePropertyName timing -NotePropertyValue ([pscustomobject]@{
    inputMs = $inputMs
    explicitWaitMs = $explicitWaitMs
    settleMs = $settleMs
    captureMs = $captureMs
    encodeMs = $encodeMs
    workerMs = [int][Math]::Round($totalTimer.Elapsed.TotalMilliseconds)
  }) -Force
  return $shot
}

function Invoke-Operation([string]$Operation, $Payload) {
  switch ($Operation) {
    "screenshot" { return Invoke-Screenshot $Payload }
    "clipboard_read" { return Invoke-ClipboardRead $Payload }
    "clipboard_write" { return Invoke-ClipboardWrite $Payload }
    "window_list" { return Invoke-WindowList $Payload }
    "window_focus" { return Invoke-WindowFocus $Payload }
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
