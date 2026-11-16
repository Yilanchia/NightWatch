import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { inspectionHealth } from './inspect.js'
import { judgmentsByFinding } from './judgment.js'
import { loadPending } from './trigger.js'
import type { WatchStore } from './store.js'
import { queryTimeline, renderTimeline } from './timeline.js'
import type { WatchConfig } from './tools.js'
import type { Finding } from './types.js'

/**
 * Read-only panel: a small HTTP surface over the materialized view.
 *
 * Deliberately local: binds 127.0.0.1 by default, has no write endpoints, no authentication, and
 * is meant to be reached through an SSH tunnel. It exposes what the store already knows; it never
 * runs a collector, a repair, or a model.
 */

export interface PanelOptions {
  readonly store: WatchStore
  readonly config: WatchConfig
  readonly host?: string
  readonly port?: number
  readonly now?: () => number
  /** judgments.jsonl; defaults next to nothing — API returns [] when absent. */
  readonly judgmentsPath?: string
  /** investigations-pending.jsonl; API returns [] when absent. */
  readonly pendingPath?: string
}

export interface PanelServer {
  readonly url: string
  readonly server: ReturnType<typeof createServer>
  close: () => Promise<void>
}

function findingDto(finding: Finding) {
  return {
    id: finding.id,
    key: finding.key,
    kind: finding.kind,
    severity: finding.severity,
    title: finding.title,
    status: finding.status,
    epistemic: finding.epistemic,
    firstSeen: finding.firstSeen,
    lastSeen: finding.lastSeen,
    resolvedAt: finding.resolvedAt,
    recurrenceOf: finding.recurrenceOf,
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(text)
}

function html(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(PAGE)
}

function reports(config: WatchConfig): Array<{ day: string; bytes: number; mtime: number }> {
  if (!existsSync(config.reportDir)) return []
  return readdirSync(config.reportDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => {
      const info = statSync(join(config.reportDir, name))
      return { day: name.slice(0, -3), bytes: info.size, mtime: info.mtimeMs }
    })
    .sort((left, right) => right.day.localeCompare(left.day))
}

export async function startPanel(options: PanelOptions): Promise<PanelServer> {
  const host = options.host ?? '127.0.0.1'
  const now = options.now ?? Date.now
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method !== 'GET') {
        json(response, 405, { error: 'read-only panel' })
        return
      }
      if (url.pathname === '/') {
        html(response)
        return
      }
      if (url.pathname === '/api/summary') {
        const at = now()
        const health = inspectionHealth(options.store, options.config, at)
        const open = options.store.openFindings()
        const bySeverity: Record<string, number> = {}
        for (const finding of open) bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1
        json(response, 200, {
          at,
          lastRun: health.lastRun ?? null,
          lastOkRun: health.lastOkRun ?? null,
          collectors: health.collectors,
          stale: health.stale,
          blindSpots: health.blindSpots,
          skipped: health.skipped,
          open: open.length,
          bySeverity,
          reports: reports(options.config),
        })
        return
      }
      if (url.pathname === '/api/findings') {
        json(response, 200, { findings: options.store.openFindings().map(findingDto) })
        return
      }
      if (url.pathname === '/api/timeline') {
        const key = url.searchParams.get('key')
        if (!key) {
          json(response, 400, { error: 'missing key' })
          return
        }
        const days = Number(url.searchParams.get('days') ?? 7)
        const result = queryTimeline(options.store, key, Number.isFinite(days) ? days : 7, now())
        json(response, 200, {
          key,
          points: result.points.map((point) => ({
            at: point.at,
            kind: point.kind,
            status: point.status,
            detail: point.detail,
          })),
          text: renderTimeline(result),
        })
        return
      }
      if (url.pathname === '/api/pending') {
        const pending = options.pendingPath ? loadPending(options.pendingPath) : []
        json(response, 200, {
          pending: pending.map((item) => ({
            ...item,
            title: options.store.findings('id = ?', item.findingId)[0]?.title,
            severity: options.store.findings('id = ?', item.findingId)[0]?.severity,
          })),
        })
        return
      }
      if (url.pathname === '/api/investigations') {
        const grouped = options.judgmentsPath ? judgmentsByFinding(options.judgmentsPath) : new Map()
        const investigations = [...grouped.entries()].map(([findingId, history]) => {
          const finding = options.store.findings('id = ?', findingId)[0]
          return {
            findingId,
            key: finding?.key,
            title: finding?.title,
            severity: finding?.severity,
            status: finding?.status,
            latest: history[history.length - 1],
            history,
          }
        })
        json(response, 200, { investigations })
        return
      }
      if (url.pathname === '/api/reports') {
        json(response, 200, { reports: reports(options.config) })
        return
      }
      json(response, 404, { error: 'not found' })
    })().catch((error: unknown) => {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 3092, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://${host}:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>守夜人 · 只读面板</title>
<style>
:root{color-scheme:light dark;--bg:#0f1419;--card:#171e26;--line:#26313d;--fg:#e6edf3;--muted:#8b98a5;--ok:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 2px}h2{font-size:15px;margin:28px 0 10px;color:var(--muted);font-weight:600}
.sub{color:var(--muted);margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:650;margin-top:4px}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}
input,button{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--accent)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
pre{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;color:var(--fg)}
footer{margin-top:28px;color:var(--muted);font-size:12px}
</style></head>
<body><main>
<h1>守夜人 · 只读面板</h1>
<div class="sub">数据来自 watch.jsonl 的物化视图；面板不采集、不执行、不写。通过 SSH 隧道访问。</div>
<div class="cards" id="cards"></div>
<h2>未关闭风险</h2>
<table><thead><tr><th>严重度</th><th>发现</th><th>状态</th><th>首次</th><th>最近</th></tr></thead><tbody id="findings"></tbody></table>
<h2>待调查</h2><div id="pending"></div>
<h2>调查判断</h2><div id="investigations"></div>
<h2>采集健康 / 盲区</h2><div id="health"></div>
<h2>日报</h2><table><thead><tr><th>日期</th><th>大小</th></tr></thead><tbody id="reports"></tbody></table>
<h2>时间线</h2>
<div class="row"><input id="key" placeholder="tcp:3306 或 ssh:passwordauthentication" size="38">
<input id="days" value="7" size="4"><button id="go">查询</button></div>
<pre id="timeline">输入一个事实 key 查询。</pre>
<footer id="foot"></footer>
</main>
<script>
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function ts(ms){if(!ms)return '-';var d=new Date(ms);return d.toLocaleString('zh-CN',{hour12:false})}
function statusClass(s){return s==='ok'?'ok':s==='failed'?'bad':s==='partial'?'warn':''}
async function summary(){
  var r=await fetch('/api/summary');var j=await r.json();
  var last=j.lastRun;var h=last?last.health:'none';
  var cards=[
    ['最近一轮',last?ts(last.at):'没有',''],
    ['健康',h,statusClass(h)],
    ['未关闭风险',j.open,''],
    ['最近成功',j.lastOkRun?ts(j.lastOkRun.at):'没有',''],
    ['下一轮','见 daemon 日志','']
  ];
  document.getElementById('cards').innerHTML=cards.map(function(c){
    return '<div class="card"><div class="k">'+esc(c[0])+'</div><div class="v '+c[2]+'">'+esc(c[1])+'</div></div>'}).join('');
  var f=await (await fetch('/api/findings')).json();
  document.getElementById('findings').innerHTML=f.findings.length?f.findings.map(function(x){
    return '<tr><td>'+esc(x.severity)+'</td><td>'+esc(x.title)+'<div class="sub">'+esc(x.key)+'</div></td><td>'+esc(x.status)+'</td><td>'+ts(x.firstSeen)+'</td><td>'+ts(x.lastSeen)+'</td></tr>'}).join(''):'<tr><td colspan="5">没有未关闭风险</td></tr>';
  var pd=await (await fetch('/api/pending')).json();
  document.getElementById('pending').innerHTML=pd.pending.length?pd.pending.map(function(p){
    return '<div class="card" style="margin-bottom:8px"><span class="badge">'+esc(p.reason==='recurrence'?'复发':'新发现')+'</span> '+
      '<strong>'+esc(p.title||p.findingId)+'</strong> <span class="sub">'+esc(p.key)+' · '+ts(p.at)+'</span></div>'}).join(''):'<div class="card">没有待调查项。模型未接入时，调查只入队、不伪造结论。</div>';
  var inv=await (await fetch('/api/investigations')).json();
  document.getElementById('investigations').innerHTML=inv.investigations.length?inv.investigations.map(function(g){
    var j=g.latest;if(!j)return '';
    var conf='ok';if(j.disposition==='escalate')conf='bad';else if(j.disposition==='benign-pending-owner')conf='warn';
    var html='<div class="card" style="margin-bottom:10px"><div class="row"><strong>'+esc(g.title||g.findingId)+'</strong>'+
      '<span class="badge '+conf+'">'+esc(j.disposition)+'</span><span class="badge">confidence '+esc(j.confidence)+'</span>'+
      '<span class="sub">'+esc(j.model)+' · 预算 '+esc(j.budget.calls)+' 次/'+esc(j.budget.bytes)+' B</span></div>';
    if(j.confirmed.length)html+='<div style="margin-top:8px"><span class="badge ok">已读（observed）</span><ul>'+j.confirmed.map(function(c){
      return '<li>'+esc(c.text)+' <span class="sub">['+esc(c.evidenceRef)+']</span></li>'}).join('')+'</ul></div>';
    if(j.candidates.length)html+='<div style="margin-top:8px"><span class="badge warn">模型推断（inferred）</span><ul>'+j.candidates.map(function(c){
      return '<li>'+esc(c.text)+' <span class="sub">'+esc(c.likelihood)+'</span></li>'}).join('')+'</ul></div>';
    if(j.counter.length)html+='<div style="margin-top:8px"><span class="badge">反证</span><ul>'+j.counter.map(function(c){return '<li>'+esc(c)+'</li>'}).join('')+'</ul></div>';
    if(j.gaps.length)html+='<div style="margin-top:8px"><span class="badge bad">盲区 / 没看到</span><ul>'+j.gaps.map(function(c){return '<li>'+esc(c)+'</li>'}).join('')+'</ul></div>';
    html+='<div style="margin-top:8px"><span class="badge">建议</span> '+esc(j.recommendation)+'</div></div>';
    return html;
  }).join(''):'<div class="card">还没有调查判断。模型未接入时，这一栏保持为空，不会伪造结论。</div>';
  var hh='';
  if(j.blindSpots.length)hh+='<div class="card"><div class="k">盲区</div><ul>'+j.blindSpots.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul></div>';
  if(j.stale.length)hh+='<div class="card" style="margin-top:10px"><div class="k">数据过期</div><ul>'+j.stale.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul></div>';
  if(j.skipped.length)hh+='<div class="card" style="margin-top:10px"><div class="k">未运行</div><ul>'+j.skipped.map(function(x){return '<li>'+esc(x)+'</li>'}).join('')+'</ul></div>';
  hh+='<div class="card" style="margin-top:10px"><div class="k">采集器</div><ul>'+j.collectors.map(function(c){
    return '<li>'+esc(c.name)+'：'+(c.lastStatus||'未读')+'（上次成功 '+(c.lastOkAt?ts(c.lastOkAt):'无')+'）</li>'}).join('')+'</ul></div>';
  document.getElementById('health').innerHTML=hh;
  document.getElementById('reports').innerHTML=j.reports.length?j.reports.map(function(x){
    return '<tr><td>'+esc(x.day)+'</td><td>'+esc(x.bytes)+' B</td></tr>'}).join(''):'<tr><td colspan="2">没有日报</td></tr>';
  document.getElementById('foot').textContent='刷新于 '+ts(j.at)+'（每 30 秒自动刷新）';
}
async function timeline(){
  var key=document.getElementById('key').value.trim();if(!key)return;
  var days=document.getElementById('days').value||7;
  var r=await fetch('/api/timeline?key='+encodeURIComponent(key)+'&days='+encodeURIComponent(days));
  var j=await r.json();
  document.getElementById('timeline').textContent=j.text||j.error||'（没有结果）';
}
document.getElementById('go').addEventListener('click',timeline);
summary();setInterval(summary,30000);
</script></body></html>`
