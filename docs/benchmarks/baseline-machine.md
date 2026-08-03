# Baseline Machine — Windows 10

> **Status:** To be filled with actual hardware measurements  
> **Scope:** Documents the specific test machine used for baseline benchmarks

---

## Hardware

| Component | Value |
|-----------|-------|
| **CPU** | _[fill: model, cores, threads, base/boost clock]_ |
| **GPU** | _[fill: model, VRAM, driver version]_ |
| **RAM** | _[fill: capacity, type, speed]_ |
| **Storage** | _[fill: model, type (SATA SSD/NVMe/HDD), capacity, seq read/write]_ |
| **Display** | _[fill: resolution, refresh rate, scaling percentage]_ |
| **Microphone** | _[fill: device name, type (USB/built-in/analog)]_ |
| **Webcam** | _[fill: device name, max resolution, USB version]_ |

## Software

| Component | Value |
|-----------|-------|
| **OS** | Windows 10 _[fill: build number]_ |
| **FFmpeg** | _[fill: version, build source]_ |
| **Power Plan** | Balanced |

## Thermal Notes

_[fill: Is this a laptop? Does it thermal throttle under sustained load? What ambient temperature was testing done at?]_

---

## How to Populate

Run the following commands and fill in the table above:

```powershell
# System info
systeminfo | Select-String "OS Name|OS Version|System Model|Processor|Total Physical Memory"

# GPU
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion, AdapterRAM

# Disk
Get-PhysicalDisk | Select-Object MediaType, Model, Size

# Display
Get-CimInstance Win32_DesktopMonitor | Select-Object ScreenWidth, ScreenHeight

# FFmpeg version
ffmpeg -version 2>&1 | Select-Object -First 1

# Audio devices
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | Select-String "audio"

# Video devices
ffmpeg -list_devices true -f dshow -i dummy 2>&1 | Select-String "video"
```
