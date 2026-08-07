# Baseline Machine - Windows 11

> **Status:** Development machine recorded; low-end classification and performance measurements pending
> **Scope:** Documents the specific test machine used for baseline benchmarks

---

## Hardware

| Component      | Value                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **CPU**        | 11th Gen Intel Core i5-11400H, 6 cores / 12 threads, 2.69 GHz reported max clock                                                             |
| **GPU**        | NVIDIA GeForce RTX 3050 Laptop GPU, 4 GB reported adapter memory, driver 32.0.16.1088; Intel UHD Graphics also present, driver 32.0.101.7077 |
| **RAM**        | 24 GB physical memory                                                                                                                        |
| **Storage**    | OM3PDP3-AD NVMe KDI 256 GB SSD; Intel SSDPEKNW512G8 512 GB SSD                                                                               |
| **Display**    | _[fill: resolution, refresh rate, scaling percentage]_                                                                                       |
| **Microphone** | _[fill: device name, type (USB/built-in/analog)]_                                                                                            |
| **Webcam**     | _[fill: device name, max resolution, USB version]_                                                                                           |

## Software

| Component      | Value                                             |
| -------------- | ------------------------------------------------- |
| **OS**         | Windows 11 Home, build 26200, 64-bit              |
| **FFmpeg**     | 9.0 full build from `gyan.dev`, available on PATH |
| **Power Plan** | Balanced                                          |

## Thermal Notes

Laptop: Dell G15 5511. Thermal throttling and ambient temperature are not measured yet.

---

## How to Populate

Run the following commands to refresh or complete the table above:

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
