# ASCII only. Reads a UTF-8 TSV: outWav <TAB> voiceDir <TAB> speed <TAB> kana
param([Parameter(Mandatory=$true)][string]$InFile)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Aq {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool SetDllDirectory(string lpPathName);
    [DllImport("AquesTalk.dll", CallingConvention=CallingConvention.StdCall)]
    public static extern IntPtr AquesTalk_Synthe(byte[] koe, int iSpeed, out int size);
    [DllImport("AquesTalk.dll", CallingConvention=CallingConvention.StdCall)]
    public static extern void AquesTalk_FreeWave(IntPtr wav);
}
"@
$sjis = [Text.Encoding]::GetEncoding(932)
$lastDir = ''
foreach ($line in [IO.File]::ReadAllLines($InFile, [Text.Encoding]::UTF8)) {
    if ($line -eq '') { continue }
    $f = $line -split "`t"
    $out = $f[0]; $dir = $f[1]; $speed = [int]$f[2]; $kana = $f[3]
    if ($dir -ne $lastDir) { [void][Aq]::SetDllDirectory($dir); $lastDir = $dir }
    $b = $sjis.GetBytes($kana); $b += [byte]0
    $size = 0
    $p = [Aq]::AquesTalk_Synthe($b, $speed, [ref]$size)
    if ($p -eq [IntPtr]::Zero) { Write-Output ("NG`t$out`t$size"); continue }
    $buf = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($p, $buf, 0, $size)
    [Aq]::AquesTalk_FreeWave($p)
    if ($out -ne '-') { [IO.File]::WriteAllBytes($out, $buf) }
    Write-Output ("OK`t$out`t$size")
}
