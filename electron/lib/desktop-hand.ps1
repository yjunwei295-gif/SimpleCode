# ASCII-only helper. Node writes one JSON command per line and reads one JSON line back.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = $OutputEncoding
[Console]::InputEncoding = $OutputEncoding

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class DeskHand {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
  public const int LEFTDOWN = 0x0002;
  public const int LEFTUP = 0x0004;
  public const int RIGHTDOWN = 0x0008;
  public const int RIGHTUP = 0x0010;
  public const int MIDDLEDOWN = 0x0020;
  public const int MIDDLEUP = 0x0040;
  public const int WHEEL = 0x0800;
  public const int KEYUP = 0x0002;
}
"@

function Reply([bool]$ok, [string]$message) {
  $safe = ($message | Out-String).Trim().Replace('\', '\\').Replace('"', '\"')
  Write-Output ("{""ok"":" + ($(if ($ok) { "true" } else { "false" })) + ",""message"":""" + $safe + """}")
  [Console]::Out.Flush()
}

function Click-Button([string]$button, [int]$times) {
  $down = [DeskHand]::LEFTDOWN
  $up = [DeskHand]::LEFTUP
  if ($button -eq "right") { $down = [DeskHand]::RIGHTDOWN; $up = [DeskHand]::RIGHTUP }
  elseif ($button -eq "middle") { $down = [DeskHand]::MIDDLEDOWN; $up = [DeskHand]::MIDDLEUP }
  for ($i = 0; $i -lt $times; $i++) {
    [DeskHand]::mouse_event($down, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 30
    [DeskHand]::mouse_event($up, 0, 0, 0, 0)
    if ($i + 1 -lt $times) { Start-Sleep -Milliseconds 60 }
  }
}

function Tap-Key([int]$vk) {
  [DeskHand]::keybd_event([byte]$vk, 0, 0, 0)
  Start-Sleep -Milliseconds 20
  [DeskHand]::keybd_event([byte]$vk, 0, [DeskHand]::KEYUP, 0)
}

function Button-Flags([string]$button) {
  $down = [DeskHand]::LEFTDOWN
  $up = [DeskHand]::LEFTUP
  if ($button -eq "right") { $down = [DeskHand]::RIGHTDOWN; $up = [DeskHand]::RIGHTUP }
  elseif ($button -eq "middle") { $down = [DeskHand]::MIDDLEDOWN; $up = [DeskHand]::MIDDLEUP }
  return @{ down = $down; up = $up }
}

function Drag-Path($points, [string]$button) {
  $flags = Button-Flags $button
  $held = $false
  try {
    $first = $points[0]
    [DeskHand]::SetCursorPos([int]$first.x, [int]$first.y) | Out-Null
    Start-Sleep -Milliseconds 30
    [DeskHand]::mouse_event($flags.down, 0, 0, 0, 0)
    $held = $true
    Start-Sleep -Milliseconds 40
    foreach ($p in $points) {
      [DeskHand]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null
      Start-Sleep -Milliseconds 12
    }
  } finally {
    if ($held) { [DeskHand]::mouse_event($flags.up, 0, 0, 0, 0) }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $savedX = $null
  $savedY = $null
  try {
    $cmd = $line | ConvertFrom-Json
    $op = [string]$cmd.op
    if ($op -eq "ping") { Reply $true "pong"; continue }
    $pt = New-Object DeskHand+POINT
    [DeskHand]::GetCursorPos([ref]$pt) | Out-Null
    $savedX = $pt.X
    $savedY = $pt.Y
    if ($op -eq "click" -or $op -eq "scroll") {
      [DeskHand]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null
      Start-Sleep -Milliseconds 20
    }
    if ($op -eq "drag") {
      $pts = @($cmd.points)
      if ($pts.Count -lt 2) { Reply $false "need at least 2 points"; continue }
      $button = "left"
      if ($cmd.button) { $button = [string]$cmd.button }
      Drag-Path $pts $button
    } elseif ($op -eq "click") {
      $times = 1
      if ($cmd.times) { $times = [int]$cmd.times }
      if ($times -lt 1) { $times = 1 }
      if ($times -gt 3) { $times = 3 }
      $button = "left"
      if ($cmd.button) { $button = [string]$cmd.button }
      Click-Button $button $times
    } elseif ($op -eq "scroll") {
      $delta = [int]$cmd.delta
      [DeskHand]::mouse_event([DeskHand]::WHEEL, 0, 0, $delta, 0)
    } elseif ($op -eq "key") {
      $names = @()
      if ($cmd.keys) { $names = @($cmd.keys) }
      $map = @{
        enter = 13; tab = 9; escape = 27; backspace = 8; delete = 46;
        up = 38; down = 40; left = 37; right = 39; home = 36; end = 35;
        space = 32; pageup = 33; pagedown = 34;
        ctrl = 17; alt = 18; shift = 16; win = 91
      }
      $vks = @()
      foreach ($name in $names) {
        $key = ([string]$name).ToLower()
        if ($map.ContainsKey($key)) { $vks += [int]$map[$key] }
        elseif ($key.Length -eq 1 -and $key -match "[a-z0-9]") { $vks += [int][char]$key.ToUpper() }
      }
      if (-not $vks.Count) { Reply $false "unknown key"; continue }
      foreach ($vk in $vks) { [DeskHand]::keybd_event([byte]$vk, 0, 0, 0); Start-Sleep -Milliseconds 15 }
      for ($i = $vks.Count - 1; $i -ge 0; $i--) {
        [DeskHand]::keybd_event([byte]$vks[$i], 0, [DeskHand]::KEYUP, 0)
        Start-Sleep -Milliseconds 15
      }
    } else {
      Reply $false "unknown op"
      continue
    }
    if ($op -eq "click" -or $op -eq "scroll" -or $op -eq "drag") {
      Start-Sleep -Milliseconds 30
      [DeskHand]::SetCursorPos($savedX, $savedY) | Out-Null
    }
    Reply $true "ok"
  } catch {
    if ($null -ne $savedX) {
      try { [DeskHand]::SetCursorPos([int]$savedX, [int]$savedY) | Out-Null } catch {}
    }
    Reply $false $_.Exception.Message
  }
}
