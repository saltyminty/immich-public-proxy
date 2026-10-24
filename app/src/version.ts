import { join } from 'path'
import { resolveAppVersion } from '@ipp/core'

export const APP_VERSION = resolveAppVersion(join(__dirname, '..', 'package.json'))

/** URL-safe cache-busting segment for static asset paths. */
export const ASSET_VERSION = encodeURIComponent(APP_VERSION)

const SOURCE_REPOSITORY = 'https://github.com/saltyminty/immich-public-proxy'

export function sourceOffer (revision: string | undefined, production: boolean): { url: string, exactRevision: boolean } {
  if (!revision && !production) return { url: SOURCE_REPOSITORY, exactRevision: false }
  if (!revision || revision.length !== 40 || !/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error('SOURCE_REVISION must be a full 40-character Git commit SHA for production builds')
  }
  return { url: SOURCE_REPOSITORY + '/tree/' + revision.toLowerCase(), exactRevision: true }
}

export const SOURCE_OFFER = sourceOffer(process.env.SOURCE_REVISION, process.env.NODE_ENV === 'production')
