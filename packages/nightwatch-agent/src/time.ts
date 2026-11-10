/**
 * Local wall-clock helpers. The evidence log stores epoch milliseconds; people read the machine's
 * local time, not UTC. Reports and timelines must agree with `date` on the host.
 */

export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localStamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${localDay(at)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
