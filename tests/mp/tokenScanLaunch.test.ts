import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOKEN_SCAN_PS1, tokenScannerArgs } from '../../server/utils/tokenScanScript.ts'

test('扫描脚本保持 ASCII，兼容 Windows PowerShell 的无 BOM 文件读取', () => {
  assert.match(TOKEN_SCAN_PS1, /^[\x00-\x7f]*$/)
})

test('PowerShell 后台启动能接收回传地址和 nonce（含空格的脚本路径）', {
  skip: process.platform !== 'win32',
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan launch test '))
  try {
    const script = join(dir, 'probe.ps1')
    // 复用真实参数声明，但不编译或扫描任何进程。
    writeFileSync(script, TOKEN_SCAN_PS1.split("$cs = @'")[0] +
      '\nWrite-Output ($CallbackUrl + "|" + $Nonce)\n')
    const url = 'http://127.0.0.1:3000/api/local/token-import'
    const result = spawnSync('powershell.exe', tokenScannerArgs(script, url, 'test-nonce'), {
      windowsHide: true, encoding: 'utf8', timeout: 20000,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), `${url}|test-nonce`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('扫描脚本编译后能向本机回传空结果，不访问真实微信进程', {
  skip: process.platform !== 'win32',
  timeout: 30000,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scan callback test '))
  let received: unknown
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received = { method: req.method, path: req.url, body: JSON.parse(body) }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    const script = join(dir, 'scan.ps1')
    // 只替换进程枚举；真实 C# 编译、JSON 序列化、HTTP 回传均执行。
    writeFileSync(script, TOKEN_SCAN_PS1.replace(
      "$ErrorActionPreference = 'Stop'",
      "$ErrorActionPreference = 'Stop'\nfunction Get-Process { param($Name, $ErrorAction) @() }",
    ))
    const child = spawn('powershell.exe', tokenScannerArgs(
      script, `http://127.0.0.1:${addr.port}/api/local/token-import`, 'callback-test',
    ), { windowsHide: true, stdio: 'ignore', timeout: 20000 })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    assert.equal(code, 0)
    assert.deepEqual(received, {
      method: 'POST', path: '/api/local/token-import',
      body: { nonce: 'callback-test', tokens: [], error: 'NO_PROCESS', processes: 0 },
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
