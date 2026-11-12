import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { emptyState, ingestBundle, type CoordinatorState } from './coordinator.js'
import type { NodeBundle } from './export.js'

/**
 * Local transport prototype: one HTTP endpoint that accepts signed bundles.
 *
 * Scope is deliberately narrow: this is for two machines the owner controls, over a trusted network
 * (localhost or a private link), and it is NOT production TLS. Device trust comes from explicit
 * registration plus the bundle signature, not from the channel. Anything reachable by the network
 * can still try to POST; the signature and registration decide what is accepted.
 */

const MAX_BODY = 2 * 1024 * 1024

export interface CoordinatorServerOptions {
  readonly statePath: string
  /** Defaults to 127.0.0.1; bind wider only on a trusted network. */
  readonly host?: string
  /** Defaults to 0 (random free port). */
  readonly port?: number
}

export interface CoordinatorServer {
  readonly url: string
  readonly server: ReturnType<typeof createServer>
  close: () => Promise<void>
}

function loadState(path: string, now: number): CoordinatorState {
  if (!existsSync(path)) return emptyState(now)
  return JSON.parse(readFileSync(path, 'utf8')) as CoordinatorState
}

function saveState(path: string, state: CoordinatorState): void {
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('bundle 太大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function reply(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

export async function startCoordinatorServer(options: CoordinatorServerOptions): Promise<CoordinatorServer> {
  const host = options.host ?? '127.0.0.1'
  const now = () => Date.now()
  let state = loadState(options.statePath, now())

  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? '/'
      if (request.method === 'GET' && url === '/v1/status') {
        reply(response, 200, {
          nodes: Object.keys(state.nodes),
          findings: Object.keys(state.findings).length,
          updatedAt: state.updatedAt,
        })
        return
      }
      if (request.method === 'POST' && url === '/v1/bundle') {
        let bundle: NodeBundle
        try {
          bundle = JSON.parse(await readBody(request)) as NodeBundle
        } catch (error) {
          reply(response, 400, { ok: false, reason: `无法解析 bundle：${error instanceof Error ? error.message : String(error)}` })
          return
        }
        const result = ingestBundle(state, bundle, now())
        if (!result.ok) {
          reply(response, 403, { ok: false, reason: result.reason ?? '拒绝' })
          return
        }
        state = result.state
        saveState(options.statePath, state)
        reply(response, 200, {
          ok: true,
          nodeId: result.nodeId,
          added: result.added,
          updated: result.updated,
          staleSeq: result.staleSeq,
        })
        return
      }
      reply(response, 404, { ok: false, reason: 'not found' })
    })().catch((error: unknown) => {
      reply(response, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolve())
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
