# 双击启动的快捷方式（2026-10-29 用户：每次启动都要开命令行麻烦）。
#   pwsh -NoProfile -File scripts/make-shortcut.ps1              → 项目根目录 desk-pet.lnk（不写系统盘）
#   pwsh -NoProfile -File scripts/make-shortcut.ps1 -Desktop     → 另外放一份到桌面（桌面在系统盘，用户要才加）
#   pwsh -NoProfile -File scripts/make-shortcut.ps1 -StartMenu   → 另外放一份到开始菜单“所有应用”（同上）
# 指向 node_modules 里的 electron.exe（图形程序，不弹黑框），参数是 src/main/main.ts 的绝对路径，和 npm start 一样；
# 图标 assets/icon/desk-pet.ico（scripts/make-icon.py）。快捷方式里是本机的绝对路径，不入库，项目挪了位置重跑一次。
# 桌宠已经在运行时再双击：打开设置窗口（main.ts 的 second-instance）。用的是 Windows 自带的 WScript.Shell。
param([switch]$Desktop, [switch]$StartMenu)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$main = Join-Path $root 'src\main\main.ts'
$icon = Join-Path $root 'assets\icon\desk-pet.ico'
foreach ($f in @($exe, $main, $icon)) { if (-not (Test-Path $f)) { throw "缺 $f（先 npm install；图标用 python scripts/make-icon.py 生成）" } }
$shell = New-Object -ComObject WScript.Shell
function Make([string]$path) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = $exe
  $s.Arguments = "`"$main`""
  $s.WorkingDirectory = $root
  $s.IconLocation = "$icon,0"
  $s.Description = 'desk-pet desktop pet'
  $s.Save()
  Write-Output "已生成 $path"
}
Make (Join-Path $root 'desk-pet.lnk')
if ($Desktop) { Make (Join-Path ([Environment]::GetFolderPath('Desktop')) 'desk-pet.lnk') }
if ($StartMenu) { Make (Join-Path ([Environment]::GetFolderPath('Programs')) 'desk-pet.lnk') }
