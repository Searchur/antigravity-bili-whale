import fs from 'node:fs'
import path from 'node:path'
import { dataPathsFor } from '../../src/core/data-paths.mjs'

const home = process.env.BILI_WHALE_HOME
const dp = dataPathsFor(home)
globalThis.fetch = async input => {
  const url = new URL(input)
  const endpoint = url.pathname
  fs.appendFileSync(path.join(home, 'calls.log'), endpoint + '\n')
  const json = data => Response.json({ code: 0, data })
  if (endpoint.endsWith('/nav')) {
    const ledger = dp.favorites
    if (fs.existsSync(ledger)) {
      const data = JSON.parse(fs.readFileSync(ledger))
      if (!data.items.some(x => x.bv === 'concurrent')) {
        data.items.unshift({ bv: 'concurrent', account: '101' })
        fs.writeFileSync(ledger, JSON.stringify(data))
      }
    }
    return json({ isLogin: true, mid: 101, uname: 'fixture' })
  }
  if (endpoint.endsWith('/upload_bfs')) return json({ image_url: 'https://fixture.invalid/image.jpg', image_width: 2, image_height: 2, img_size: 1 })
  if (endpoint.endsWith('/create/dyn')) {
    if (fs.existsSync(path.join(home, 'fail-accounting'))) {
      fs.mkdirSync(path.dirname(dp.quota), { recursive: true })
      fs.writeFileSync(dp.quota, 'unreadable ledger')
      return json({ dyn_id_str: '501' })
    }
    return Response.json({ code: -400, message: 'fixture rejection' })
  }
  if (endpoint.endsWith('/reply/add')) return Response.json({ code: -400, message: 'fixture rejection' })
  if (endpoint.endsWith('/view')) return json({ title: 'fixture', owner: {}, pic: 'https://fixture.invalid/cover' })
  if (url.hostname === 'fixture.invalid') return new Response('no image', { status: 404 })
  throw Error('Unexpected request ' + endpoint)
}

