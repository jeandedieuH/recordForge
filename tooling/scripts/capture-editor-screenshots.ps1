#Requires -Version 7.2
<#
.SYNOPSIS
    Captures reference screenshots of the recordForge editor at the supported window sizes.

.DESCRIPTION
    This script resizes the active recordForge window to each supported size and captures
    the client area using FFmpeg gdigrab. It is intended for manual Phase 0/3/9 baseline
    capture on the Windows 11 baseline machine. The output is written to
    docs/design/editor-screenshots/.

.PREREQUISITES
    - recordForge is running (`bun run tauri:dev` or a release build).
    - FFmpeg is in PATH or $env:FFMPEG_PATH is set.
    - The main window title matches $env:RECORDFORGE_WINDOW_TITLE (default "recordForge").
    - The editor fixture is already open.

.EXAMPLE
    .\tooling\scripts\capture-editor-screenshots.ps1
#>

param (
    [string]$WindowTitle = $env:RECORDFORGE_WINDOW_TITLE ?? "recordForge",
    [string]$Ffmpeg = $env:FFMPEG_PATH ?? "ffmpeg",
    [string]$OutputDir = "$PSScriptRoot\..\..\docs\design\editor-screenshots",
    [int]$CaptureDelayMs = 1200
)

$ErrorActionPreference = "Stop"

$sizes = @(
    @{ Name = "editor-1024x768-minimum";  Width = 1024; Height = 768 },
    @{ Name = "editor-1280x800-default";  Width = 1280; Height = 800 },
    @{ Name = "editor-1440x900-baseline"; Width = 1440; Height = 900 },
    @{ Name = "editor-1920x1080-standard"; Width = 1920; Height = 1080 },
    @{ Name = "editor-2560x1440-large";   Width = 2560; Height = 1440 }
)

$null = New-Item -ItemType Directory -Force -Path $OutputDir

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Window {
    [DllImport("user32.dll")] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);
    public struct RECT { public int Left, Top, Right, Bottom; }
    public struct POINT { public int X, public int Y; }
    public static readonly IntPtr HWND_TOP = new IntPtr(0);
    public const uint SWP_SHOWWINDOW = 0x0040;
}
"@

$hWnd = [Win32Window]::FindWindow($null, $WindowTitle)
if ($hWnd -eq 0) {
    throw "recordForge window with title '$WindowTitle' not found. Start the app and open the editor."
}

$baseRect = New-Object Win32Window+RECT
[Win32Window]::GetWindowRect($hWnd, [ref]$baseRect) | Out-Null
$borderLeft = 0
$borderTop = 0
$borderRight = 0
$borderBottom = 0

# Compute the border offsets once so we can request the correct client size.
$client = New-Object Win32Window+RECT
[Win32Window]::GetClientRect($hWnd, [ref]$client) | Out-Null
$windowW = $baseRect.Right - $baseRect.Left
$windowH = $baseRect.Bottom - $baseRect.Top
$clientW = $client.Right - $client.Left
$clientH = $client.Bottom - $client.Top
$borderH = $windowH - $clientH
$borderW = $windowW - $clientW

foreach ($size in $sizes) {
    $targetW = $size.Width + $borderW
    $targetH = $size.Height + $borderH
    [Win32Window]::SetWindowPos($hWnd, [Win32Window]::HWND_TOP, $baseRect.Left, $baseRect.Top, $targetW, $targetH, [Win32Window]::SWP_SHOWWINDOW) | Out-Null
    Start-Sleep -Milliseconds $CaptureDelayMs

    # Get client offset in screen coordinates.
    $pt = New-Object Win32Window+POINT
    [Win32Window]::ClientToScreen($hWnd, [ref]$pt) | Out-Null
    $outPath = Join-Path $OutputDir "$($size.Name).png"

    $args = @(
        "-y",
        "-f", "gdigrab",
        "-framerate", "1",
        "-offset_x", $pt.X,
        "-offset_y", $pt.Y,
        "-video_size", "$($size.Width)x$($size.Height)",
        "-i", "desktop",
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        $outPath
    )

    & $Ffmpeg @args
    if ($LASTEXITCODE -ne 0) {
        throw "FFmpeg capture failed for $($size.Name)"
    }

    Write-Host "Captured $outPath"
}

Write-Host "Done. Reference screenshots saved to $OutputDir"
