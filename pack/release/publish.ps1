# 一键发布 totoro-heaven release（读 Windows 凭据管理器 token -> 设 GH_TOKEN -> node release.cjs）
# 用法：.\pack\release\publish.ps1                                   （默认用 package.json 的 version 作为 tag）
#       .\pack\release\publish.ps1 -Tag 1.0.4                        （覆盖 tag）
#       .\pack\release\publish.ps1 -Tag 1.2.6 -Zip dist/x.zip -SevenZip dist/x.7z -Notes dist/body.md
#       .\pack\release\publish.ps1 -Tag 1.2.6 -ExtraArgs @('--zip','dist/x.zip')
#
# ⚠️ 2026-09-30（1.2.6 发布时踩到）：**原版只把 -Tag 传下去**，`--zip/--sevenZip/--notes` 一律被
#    静默丢掉（PowerShell 对"没声明的额外参数"不报错）⇒ 发预发布件（附件名带 -pre<n> 后缀）时
#    会回落到默认路径、报"找不到发布附件 <默认名>"，看起来像文件不存在，实际是参数没传过去。
#    现在：显式参数与 -ExtraArgs（原样透传）都会被转发；**转发用哈希表 splat**（数组 splat 会按空格
#    重新切分含空格的参数值 —— 这是本项目已有记录的坑）。
param(
  [string]$Tag = '',
  [string]$Zip = '',
  [string]$SevenZip = '',
  [string]$Notes = '',
  [string[]]$ExtraArgs = @()
)

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $Tag) {
  $Tag = (& node -e "console.log(require(process.argv[1]).version)" (Join-Path $root 'package.json')).Trim()
}
if (-not $Tag) { Write-Host 'cannot resolve version from package.json'; exit 1 }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Cred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr cred);
  public static string GetStr(string target, int type) {
    IntPtr p; if (!CredRead(target, type, 0, out p)) return "";
    var c = Marshal.PtrToStructure<CREDENTIAL>(p);
    string s="";
    if (c.CredentialBlobSize>0 && c.CredentialBlob!=IntPtr.Zero) {
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      s = System.Text.Encoding.Unicode.GetString(b);
    }
    CredFree(p);
    return s;
  }
}
'@

$tok = [Cred]::GetStr('git:https://github.com', 1)
# 2026-09-20 audit fix: accept every GitHub token family (the old `gho_`-only check treated a
# classic `ghp_` / fine-grained `github_pat_` credential in the store as "no token found").
if ($tok -match '^(gho_|ghp_|github_pat_)') {
  $env:GH_TOKEN = $tok
  Write-Host ("token ok (len " + $tok.Length + ") -> publishing tag " + $Tag)
  # 2026-09-30：显式参数与 -ExtraArgs 都转发（原来只转发 -Tag，见文件头的说明）
  $nodeArgs = @('--use-system-ca', (Join-Path $PSScriptRoot 'release.cjs'), '--tag', $Tag)
  if ($Zip) { $nodeArgs += @('--zip', $Zip) }
  if ($SevenZip) { $nodeArgs += @('--sevenZip', $SevenZip) }
  if ($Notes) { $nodeArgs += @('--notes', $Notes) }
  foreach ($x in $ExtraArgs) { $nodeArgs += $x }
  $splat = @{ FilePath = 'node'; ArgumentList = $nodeArgs; NoNewWindow = $true; Wait = $true; PassThru = $true }
  $p = Start-Process @splat
  $code = $p.ExitCode
  if ($code -ne 0) {
    Write-Host ("publish FAILED (node exit " + $code + ")")
    exit $code
  }
  Write-Host 'publish ok'
} else {
  Write-Host '未能从 Windows 凭据管理器读取 GitHub token（git:https://github.com）'
  exit 1
}
