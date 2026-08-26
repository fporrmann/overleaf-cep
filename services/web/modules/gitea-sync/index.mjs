import Settings from '@overleaf/settings'
import Modules from '../../app/src/infrastructure/Modules.mjs'
import logger from '@overleaf/logger'

let GiteaSyncModule = {}
if (process.env.GITEA_SYNC_ENABLED?.toLowerCase() === 'true') {
  logger.debug({}, 'Enabling Gitea Sync module')

  // The GITEA_SYNC_URL variable has to be set for this module to work, otherwise the module will not be enabled
  if (!process.env.GITEA_SYNC_URL || !process.env.GITEA_SYNC_CLIENT_ID || !process.env.GITEA_SYNC_CLIENT_SECRET) {
    logger.warn({}, 'Gitea Sync module is enabled but not all mandatory environment variables are set, stopping module initialization')
  } else {
    const siteUrl = Settings.siteUrl.replace(/\/+$/, '') || 'http://localhost'
    Settings.giteaSync = {
      url: process.env.GITEA_SYNC_URL.replace(/\/+$/, ''),
      clientID: process.env.GITEA_SYNC_CLIENT_ID,
      clientSecret: process.env.GITEA_SYNC_CLIENT_SECRET,
      callbackURL: `${siteUrl}/user/gitea-sync/oauth2/callback`,
      defaultBranch: process.env.GITEA_DEFAULT_BRANCH || 'main',
      pullRequestPollInterval: process.env.GITEA_PULL_REQUEST_POLL_INTERVAL_MS || 5000,
      pullRequestTimeout: process.env.GITEA_PULL_REQUEST_TIMEOUT_MS || 60_000,
    }

    const [{ default: GiteaSyncRouter },
           { default: SyncStateManager },
           { default: TokenManager }
          ] =
      await Promise.all([
        import('./app/src/GiteaSyncRouter.mjs'),
        import('./app/src/SyncStateManager.mjs'),
        import('./app/src/TokenManager.mjs'),
      ])

    // Delete project sync state from mongo (hook 'projectExpired')
    Modules.hooks.attach('projectExpired', async projectId => {
      try {
        await SyncStateManager.removeProjectState(projectId)
        logger.debug({ projectId }, 'on project expire: removed Gitea sync state')
      } catch (err) {
        logger.warn({ projectId, err }, 'on project expire: failed to remove Gitea sync state')
      }
    })

    // Delete user gitea token from mongo (hook 'expireDeletedUser')
    Modules.hooks.attach('expireDeletedUser', async userId => {
      try {
        await TokenManager.removeUserToken(userId)
      } catch (err) {
        logger.warn({ userId, err }, 'on user expire: failed removing user token')
      }
    })

    GiteaSyncModule = {
      router: GiteaSyncRouter,
    }
  }
}

export default GiteaSyncModule
