import AbortError from 'node-fetch'
import logger from '@overleaf/logger'
import Settings from '@overleaf/settings'

import {
  fetchJson,
  fetchJsonWithResponse,
  fetchStreamWithResponse,
  fetchNothing,
  fetchStream,
  RequestFailedError,
} from '@overleaf/fetch-utils'

import {
  InvalidTokenError,
  NotFoundError,
  GitConflictError,
  RateLimitError,
  ProviderRequestError,
  PermissionDeniedError,
  AlreadyExistsError,
} from './GitSyncErrors.mjs'

const GITEA_URL = Settings.giteaSync?.url
const GITEA_API_BASE = `${GITEA_URL}/api/v1`
const GITEA_DEFAULT_BRANCH = Settings.giteaSync?.defaultBranch
const MAX_PER_PAGE = 100  // Gitea REST API limit

const REQUEST_TIMEOUT_MS = 60 * 1000
const REQUEST_LONG_TIMEOUT_MS = 600 * 1000

const PULL_REQUEST_POLL_INTERVAL_MS = Settings.giteaSync?.pullRequestPollInterval
const PULL_REQUEST_TIMEOUT_MS = Settings.giteaSync?.pullRequestTimeout


const maxConcurrency = process.env.GITEA_API_MAX_CONCURRENCY || 5

function buildHeaders(token) {
  return {
    Accept: 'application/vnd.gitea+json',
    'Content-Type': 'application/json',
    'User-Agent': 'Overleaf-CEP-Gitea-Sync',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

// Error handling
function isRateLimitError(response) {
  const remaining = response.headers.get('x-ratelimit-remaining')
  const retryAfter = response.headers.get('retry-after')

  return remaining === '0' || retryAfter != null
}

function isRepositoryAlreadyExistsError(err) {
  if (err.response?.status !== 409) {
    return false
  }

  let body = err.body

  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return false
    }
  }

  const msg = body?.message

  return msg && typeof msg === 'string' && msg.toLowerCase().includes('already exists')
}

function normalizeGiteaError(err, operation) {
  const ebody = err.body || {}
  logger.error({ operation, err, ebody }, 'Gitea API request failed')

  if (err.name === 'AbortError') {
    throw new ProviderRequestError('Gitea request timed out', { status: 504 }, err)
  }

  if (!(err instanceof RequestFailedError)) {
    throw new ProviderRequestError('Something wrong with Gitea request', { status: 500 }, err)
  }

  const status = err.response?.status || 500

  if (status === 401) {
    throw new InvalidTokenError('Invalid token', { status }, err)
  }

  if (status === 404) {
    throw new NotFoundError('Not found', { status }, err)
  }

  if (status === 409) {
    if (isRepositoryAlreadyExistsError(err)) {
      throw new AlreadyExistsError('Repository already exists', { status }, err)
    }
  }

  if (status === 409) {
    throw new GitConflictError()
  }

  if (status === 403 || status === 429) {
    if (isRateLimitError(err.response)) throw new RateLimitError('Rate limit exeeded', { status: 429 }, err)
    throw new PermissionDeniedError('Permission denied', { status: 403 }, err)
  }

  throw new ProviderRequestError('Gitea request failed', { status }, err)
}

// wrappers
function fetchGiteaJson(url, options, operation) {
  return fetchJson(url, options).catch(err => {
    normalizeGiteaError(err, operation)
  })
}

function fetchGiteaJsonWithResponse(url, options, operation) {
  return fetchJsonWithResponse(url, options).catch(err => {
    normalizeGiteaError(err, operation)
  })
}

function fetchGiteaStreamWithResponse(url, options, operation) {
  return fetchStreamWithResponse(url, options).catch(err => {
    normalizeGiteaError(err, operation)
  })
}

function fetchGiteaNothing(url, options, operation) {
  return fetchNothing(url, options).catch(err => {
    normalizeGiteaError(err, operation)
  })
}

function fetchGiteaStream(url, options, operation) {
  return fetchStream(url, options).catch(err => {
    normalizeGiteaError(err, operation)
  })
}

function getTokenRefreshTimestamp(token, safetyMarginInSec = 300) {
    return (Date.now() / 1000) + token.expires_in - safetyMarginInSec;
}


async function compareCommitsFull(token, repoFullName, from, to) {
  const url = `${GITEA_API_BASE}/repos/${repoFullName}/compare/${from}...${encodeURIComponent(to)}`
  return await fetchGiteaJson(url, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
  }, 'listNewCommitsWithStatus')
}


// ---------------------- exports ------------------------------- //

// OAuth
function getOAuth2Url() {
  logger.info({ url: GITEA_URL, clientID: Settings.giteaSync.clientID }, 'Generating Gitea OAuth2 URL')
  const oAuthUrl = new URL(`${GITEA_URL}/login/oauth/authorize`)
  oAuthUrl.searchParams.append('client_id', Settings.giteaSync.clientID)
  oAuthUrl.searchParams.append('redirect_uri', Settings.giteaSync.callbackURL)
  oAuthUrl.searchParams.append('response_type', 'code')
  oAuthUrl.searchParams.append('scope', 'read:organization,repository')
  return oAuthUrl
}

function exchangeCodeForToken(code) {
  return fetchGiteaJson(`${GITEA_URL}/login/oauth/access_token`, {
    method: 'POST',
    headers: buildHeaders(),
    json: {
      code,
      client_id: Settings.giteaSync.clientID,
      client_secret: Settings.giteaSync.clientSecret,
      redirect_uri: Settings.giteaSync.callbackURL,
      grant_type: "authorization_code",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'exchangeCodeForToken').then(r => [r.access_token, r.refresh_token, getTokenRefreshTimestamp(r)])
}

function refreshToken(refreshToken) {
  return fetchGiteaJson(`${GITEA_URL}/login/oauth/access_token`, {
    method: 'POST',
    headers: buildHeaders(),
    json: {
      client_id: Settings.giteaSync.clientID,
      client_secret: Settings.giteaSync.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'refreshToken').then(r => [r.access_token, r.refresh_token, getTokenRefreshTimestamp(r)])
}

function revokeToken(token) {
  return true // Gitea currently does not implement a way to revoke a token
}

// user, orgs, permissions
function getUser(token) {
  return fetchGiteaJson(`${GITEA_API_BASE}/user`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, 'getUser').then(({ id, login, login_name }) => ({ id, login, name: login_name }))
}

// TODO: Fully implement this
async function getUserAndOrgs(token) {
  const { id, login, name } = await getUser(token)

  return {
    user: login,
    orgs: []
  }
}

function getPushPermission(token, repoFullName) {
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, 'getPushPrmission').then(repo => (repo.permissions?.push === true))
}

// repos
function createRepo(token, { name, description, isPublic, org }) {
  const url = org ? `${GITEA_API_BASE}/orgs/${org}/repos` : `${GITEA_API_BASE}/user/repos`
  return fetchGiteaJson(url, {
    method: 'POST',
    headers: buildHeaders(token),
    json: {
      name,
      description,
      private: !isPublic,
      default_branch: GITEA_DEFAULT_BRANCH,
      auto_init: false,
    },
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
  }, 'createRepo')
}

async function _listUserReposPage(token, page) {
  const params = new URLSearchParams({
    page: page.toString(),
    per_page: MAX_PER_PAGE.toString(),
  })

  const { json, response } = await fetchGiteaJsonWithResponse(`${GITEA_API_BASE}/user/repos?${params}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }, '_listUserReposPage')

  const link = response.headers.get('link') || ''
  const hasNext = link.includes('rel="next"')

  return {
    repos: json.map(r => ({
      name: r.name,
      fullName: r.full_name,
      defaultBranchName: r.default_branch,
    })),
    hasNext,
  }
}

async function listUserRepos(token) {
  let all = []
  let page = 1

  while (true) {
    const { repos, hasNext } = await _listUserReposPage(token, page)
    all = all.concat(repos)
    if (!hasNext) break
    page++
  }

  return all
}

// Git (blobs / trees / commits)
function uploadBlob(token, repoFullName, buffer) {
  void token
  void repoFullName

  if (Buffer.isBuffer(buffer)) {
    return Promise.resolve(buffer.toString('base64'))
  }

  if (typeof buffer === 'string') {
    return Promise.resolve(buffer)
  }

  return Promise.resolve(String(buffer))
}

function getBlobStream(token, repoFullName, ref, path) {
  const encodedPath = encodeURIComponent(path).replace(/%2F/g, '/')

  return fetchGiteaStream(`${GITEA_API_BASE}/repos/${repoFullName}/raw/${encodedPath}?ref=${ref}`, {
    headers: {
      ...buildHeaders(token),
      Accept: 'application/vnd.gitea.raw',
    },
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
  }, 'getBlobStream')
}

function createTree(token, repoFullName, entries, baseTree) {
  void token
  void repoFullName

  const existingPaths = new Set((baseTree || []).map(entry => entry.path))
  const files = []

  for (const entry of entries) {
    if (entry.sha == null) {
      files.push({
        operation: 'delete',
        path: entry.path,
        sha: entry.sha,
      })
      continue
    }

    files.push({
      operation: existingPaths.has(entry.path) ? 'update' : 'create',
      path: entry.path,
      content: entry.content,
    })
  }

  return Promise.resolve({ 
    baseTree: baseTree || [],
    entries: files,
  })
}

function createCommit(token, repoFullName, { tree, message, branch }) {
  const payload = {
    branch: branch || GITEA_DEFAULT_BRANCH,
    message,
    files: tree.entries,
  }

  return fetchGiteaJson(
    `${GITEA_API_BASE}/repos/${repoFullName}/contents`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    'createCommit'
  ).then(r => r.commit.sha)
}

function getCommitTree(token, repoFullName, commit) {
  return listBlobsAtCommit(token, repoFullName, commit)
}

function listBlobsAtCommit(token, repoFullName, commit) {
  // can use commit sha here instead of tree sha
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/git/trees/${commit}?recursive=1`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
  }, 'listBlobsAtCommit').then(r =>
    (r.tree || [])
      .filter(entry => entry.type === 'blob')
      .map(entry => ({
        sha: entry.sha,
        path: entry.path
      }))
  )
}

async function getBlobContent(token, repoFullName, sha) {
  if (!sha) return null

  const url = `${GITEA_API_BASE}/repos/${repoFullName}/git/blobs/${sha}`

  return await fetchGiteaJson(url, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
  }, 'getBlobContent').then(r => r.content || '')
}

async function listNewCommitsWithStatus(token, fullName, branchName, fromCommit) {
  const forward = await compareCommitsFull(token, fullName, fromCommit, branchName);
  const reverse = await compareCommitsFull(token, fullName, branchName, fromCommit);

  const forwardHasCommits = (forward.commits || []).length > 0
  const reverseHasCommits = (reverse.commits || []).length > 0

  let diverged = false

  if (forwardHasCommits && !reverseHasCommits) {
    // Ahead
  }
  else if (!forwardHasCommits && reverseHasCommits) {
    // Behind
    diverged = true
  }
  else if (forwardHasCommits && reverseHasCommits) {
    // Diverged
    diverged = true
  }
  else {
    // Identical
  }

  const commits = (forward.commits || []).map(c => ({
    message: c.commit?.message || '',
    author: {
      name: c.commit?.author?.name || '',
      email: c.commit?.author?.email || '',
      date: c.commit?.author?.date || '',
    },
    sha: c.sha,
  }))

  return { commits, diverged }
}

// branches
function getBranchHead(token, repoFullName, branchName) {
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/git/refs/heads/${encodeURIComponent(branchName)}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'getBranchHead').then(r =>  {
    if (Array.isArray(r) && r.length > 0) {
      if (r[0].object && r[0].object.sha) {
        return r[0].object.sha
      }
    }
    throw new NotFoundError(`Branch ${branchName} not found in repository ${repoFullName}`, { status: 404 })
  })
}

function createBranch(token, repoFullName, branchName, sha) {
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/branches`, {
    method: 'POST',
    headers: buildHeaders(token),
    json: {
      new_branch_name: branchName,
      old_ref_name: sha,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'createBranch')
}

function updateBranch(token, repoFullName, branchName, sha, force = false) {
}

function deleteBranch(token, repoFullName, branchName) {
  return fetchGiteaNothing(`${GITEA_API_BASE}/repos/${repoFullName}/branches/${encodeURIComponent(branchName)}`, {
    method: 'DELETE',
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'deleteBranch')
}

function doesBranchExist(token, repoFullName, branchName) {
  if (!branchName || branchName === GITEA_DEFAULT_BRANCH) {
    // The default branch can be expected to always exist
    return Promise.resolve(true)
  }

  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/branches/${encodeURIComponent(branchName)}`, {
    method: 'GET',
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'doesBranchExist').then(() => true).catch(err => {
    if (err instanceof NotFoundError) {
      return false
    }
    throw err
  })
}

// merge / compare
async function getPullRequest(token, repoFullName, pullNumber) {
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/pulls/${pullNumber}`, {
    method: 'GET',
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'getPullRequest')
}

async function mergePullRequest(token, repoFullName, pullNumber) {
  const mergeable = await checkPullRequestMergeable(token, repoFullName, pullNumber, PULL_REQUEST_TIMEOUT_MS)
  if (!mergeable) {
    throw new GitConflictError(`Pull request ${pullNumber} is not mergeable`)
  }

  return fetchGiteaNothing(`${GITEA_API_BASE}/repos/${repoFullName}/pulls/${pullNumber}/merge`, {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        do: "merge",
        delete_branch_after_merge: true,
      },
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
    },
    'mergePullRequest'
  ).then(() => true).catch(err => { throw err })
}

async function createPullRequest(token, repoFullName, base, head) {
  return fetchGiteaJson(
    `${GITEA_API_BASE}/repos/${repoFullName}/pulls`,
    {
      method: 'POST',
      headers: buildHeaders(token),
      json: {
        title: `Merge ${head} into ${base}`,
        head,
        base
      },
      signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS)
    },
    'createPullRequest'
  )
}

// Default to -1 which means no timeout
async function checkPullRequestMergeable(token, repoFullName, pullNumber, timeoutMS = -1) {
  const startedAt = Date.now()

  while(true) {
    const pr = await getPullRequest(token, repoFullName, pullNumber)

    if (pr.mergeable) {
      return true
    }

    if (timeoutMS == -1 || Date.now() - startedAt > timeoutMS) {
      return false
    }

    await new Promise(resolve => setTimeout(resolve, PULL_REQUEST_POLL_INTERVAL_MS))
  }
}

async function waitForMergeToBeDone(token, repoFullName, prNumber) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < PULL_REQUEST_TIMEOUT_MS) {
    const pr = await getPullRequest(token, repoFullName, prNumber)

    if (pr.merged) {
      return pr.merge_commit_sha
    }

    await new Promise(resolve => setTimeout(resolve, PULL_REQUEST_POLL_INTERVAL_MS))
    continue
  }

  const pr = await getPullRequest(token, repoFullName, prNumber)
  logger.info({pr}, 'waitForMergeToBeDone')
  if (!pr.mergeable) {
    throw new GitConflictError(`Pull request ${prNumber} is not mergeable`)
  }
}

function mergeBranch(token, repoFullName, base, head) {
  return createPullRequest(token, repoFullName, base, head)
    .then(async pr => {
      await mergePullRequest(token, repoFullName, pr.number)
      return await waitForMergeToBeDone(token, repoFullName, pr.number)
    })
}

function compareCommits(token, repoFullName, from, to) {
  return fetchGiteaJson(`${GITEA_API_BASE}/repos/${repoFullName}/compare/${from}...${to}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }, 'compareCommits').then(r => { r.files || [] })
}

// zip
function getRepoZipball(token, repoFullName, sha) {
  return fetchGiteaStream(`${GITEA_API_BASE}/repos/${repoFullName}/zipball/${sha}`, {
    headers: buildHeaders(token),
    signal: AbortSignal.timeout(REQUEST_LONG_TIMEOUT_MS),
  }, 'getRepoZipball')
}

export default {
  maxConcurrency,
  getOAuth2Url,
  exchangeCodeForToken,
  refreshToken,
  revokeToken,
  getUser,
  getUserAndOrgs,
  getPushPermission,
  createRepo,
  listUserRepos,
  uploadBlob,
  getBlobStream,
  createTree,
  createCommit,
  getCommitTree,
  listBlobsAtCommit,
  getBlobContent,
  listNewCommitsWithStatus,
  getBranchHead,
  createBranch,
  updateBranch,
  deleteBranch,
  doesBranchExist,
  mergeBranch,
  compareCommits,
  getRepoZipball,
}
