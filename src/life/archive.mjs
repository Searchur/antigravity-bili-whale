import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson } from '../core/atomic-json.mjs'
import { cognitiveState, learningKinds } from '../memory/cognition.mjs'
import { archiveDigest, readLifeArchive } from '../memory/archive-reader.mjs'

export { archiveDigest, readLifeArchive }

const DAY = 86400000
const id = () => crypto.randomUUID()

/**
 * Compacts the event log without owning checkpoint commits.
 * References from live memories, proposals, drafts and in-flight jobs are protected.
 */
export function archiveLifeState(state, { dir, now, cfg }, force = false) {
  const protectedIDs = new Set([
    ...state.memories.filter(memory => memory.active),
    ...state.proposals.filter(proposal => proposal.status === 'pending'),
    ...state.drafts.filter(draft => ['pending', 'editing'].includes(draft.status)),
  ].flatMap(item => [
    ...(item.sourceIds ?? []),
    ...(item.counterEvidenceIds ?? []),
    ...(item.originEvidenceIds ?? []),
    ...(item.relevance?.tags ?? []).map(tag => tag.eventId),
  ]))

  for (const job of state.cognition?.jobs ?? []) {
    if (['extract', 'review', 'review_pending', 'retry_pending'].includes(job.stage) && job.expiresAt > now()) {
      for (const input of job.inputs) protectedIDs.add(input.id)
    }
  }

  // Preserve a bounded recent unprocessed window; older overflow remains in cold storage.
  for (const event of state.events.filter(event =>
    event.seq > (state.cognition?.cursor ?? 0) &&
    learningKinds.has(event.kind) &&
    now() - event.at < cfg.retentionDays * DAY
  ).slice(-200)) {
    protectedIDs.add(event.id)
  }
  for (const event of state.events.filter(event => event.seq > (state.affect?.cursor ?? Infinity)).slice(0, 200)) {
    protectedIDs.add(event.id)
  }

  const keep = []
  const old = []
  const boundary = now() - cfg.retentionDays * DAY
  state.events.forEach((event, index) => (
    !protectedIDs.has(event.id) &&
    !(event.kind === 'sent' && now() - event.at < cfg.duplicateHours * 3600000) &&
    (event.at < boundary || index < state.events.length - cfg.maxEvents)
      ? old
      : keep
  ).push(event))

  const forget = cfg.forgetExpiredEvents !== false
  const forgotten = forget ? old.filter(event => event.at < boundary) : []
  const archived = old.filter(event => !forgotten.includes(event))
  if (archived.length) {
    if (state.affect) {
      const lost = archived.filter(event => event.seq > state.affect.cursor).length
      state.affect.archivedUnprocessed = (state.affect.archivedUnprocessed ?? 0) + lost
    }
    const cognition = cognitiveState(state)
    cognition.archivedUnprocessed = (cognition.archivedUnprocessed ?? 0) +
      archived.filter(event => event.seq > cognition.cursor && learningKinds.has(event.kind)).length
    const archivedKeys = archived.map(event => event.key).filter(Boolean)
    if (archivedKeys.length) {
      state.settings ??= {}
      state.settings.archivedEventKeys = [...new Set([...(state.settings.archivedEventKeys ?? []), ...archivedKeys])].slice(-500)
    }
    const name = 'events-' + now() + '-' + id() + '.json'
    const payload = { version: 1, events: archived }
    atomicWriteJson(path.join(dir, 'archive', name), payload)
    const digest = archiveDigest(fs.readFileSync(path.join(dir, 'archive', name), 'utf8'))
    state.archives.push({
      name,
      digest,
      count: archived.length,
      from: archived[0].at,
      to: archived.at(-1).at,
    })
  }

  state.events = keep
  if (forgotten.length) {
    state.settings = {
      ...(state.settings ?? {}),
      forgottenEvents: (state.settings?.forgottenEvents ?? 0) + forgotten.length,
    }
  }

  // Never discard unresolved writes or thread closure state during compaction.
  state.leases = state.leases.filter(lease => lease.expiresAt > now() - 7 * DAY)

  // Move completed administrative history to the same searchable cold store.
  const historical = []
  for (const [key, finished] of [
    ['proposals', proposal => proposal.status !== 'pending'],
    ['memories', memory => !memory.active],
    ['agenda', item => item.status === 'done'],
    ['drafts', draft => !['pending', 'editing'].includes(draft.status)],
  ]) {
    const done = state[key].filter(finished)
    const remove = new Set(done.slice(0, -100).map(item => item.id))
    for (const item of state[key]) {
      if (remove.has(item.id)) {
        historical.push({
          id: item.id,
          at: item.at,
          kind: 'history-' + key,
          text: item.text ?? '',
          origin: 'tool',
          data: item,
        })
      }
    }
    state[key] = state[key].filter(item => !remove.has(item.id))
  }
  if (historical.length) {
    const name = 'history-' + id() + '.json'
    atomicWriteJson(path.join(dir, 'archive', name), { version: 1, events: historical })
    state.archives.push({
      name,
      digest: archiveDigest(fs.readFileSync(path.join(dir, 'archive', name), 'utf8')),
      count: historical.length,
      from: historical[0].at,
      to: historical.at(-1).at,
    })
  }
  if (force) state.settings.lastArchiveAt = now()
}
