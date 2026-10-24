import { ThemeScript } from '@ipp/core'
import { APP_VERSION, ASSET_VERSION, SOURCE_OFFER } from '../version'

export function About () {
  return (
    <html lang="en">
      <head>
        <ThemeScript/>
        <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
        <title>About Immich Public Proxy</title>
        <link rel="icon" href="/share/static/favicon.ico" type="image/x-icon"/>
        <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/theme.css`}/>
        <link type="text/css" rel="stylesheet" href={`/share/static/${ASSET_VERSION}/style.css`}/>
      </head>
      <body>
        <main class="about-page">
          <h1>Immich Public Proxy</h1>
          <p class="about-version">Version {APP_VERSION}</p>
          <p>This gallery uses a custom build of Immich Public Proxy with tag filtering.</p>
          <p>
            <a href="https://github.com/alangrainger/immich-public-proxy" rel="noopener noreferrer">Immich Public Proxy</a>
            {' is free software under the '}
            <a href="https://github.com/alangrainger/immich-public-proxy/blob/v4.1.1/LICENSE" rel="noopener noreferrer">GNU Affero General Public License v3</a>.
          </p>
          <p class="about-source">
            <a href={SOURCE_OFFER.url} rel="noopener noreferrer">
              {SOURCE_OFFER.exactRevision ? 'View this build’s source on GitHub' : 'View source on GitHub'}
            </a>
          </p>
        </main>
      </body>
    </html>
  )
}
