import * as core from '@actions/core'
import {Octokit} from 'octokit'
import YAML from 'yaml'
import GetDateFormatted from './utils'
import dotenv from 'dotenv'

import {removeToken, getReadmeContent} from './optionalActions'
import {findAllRepos} from './coreFunctions'

dotenv.config()

const getInputOrEnv = (input: string) =>
  core.getInput(input) || process.env.input || ''
//Optional values
const removeTokenSetting = getInputOrEnv('removeToken')
const fetchReadmesSetting = getInputOrEnv('fetchReadmes')

async function run(): Promise<void> {
  core.info('Starting')
  try {
    const PAT = getInputOrEnv('PAT')
    const user = getInputOrEnv('user')
    const organization = getInputOrEnv('organization')
    const baseUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
    const isEnterpriseServer = baseUrl !== 'https://api.github.com'

    if (!PAT) {
      core.setFailed(
        "Parameter 'PAT' is required to load all actions from the organization or user account"
      )
      return
    }

    if (user === '' && organization === '') {
      core.setFailed(
        "Either parameter 'user' or 'organization' is required to load all actions from it. Please provide one of them."
      )
      return
    }

    const octokit = new Octokit({
      auth: PAT,
      baseUrl: baseUrl
    })

    try {
      // this call fails from an app, so we need a better way to validate this
      //const currentUser = await octokit.rest.users.getAuthenticated()
      //core.info(`Hello, ${currentUser.data.login}`)
    } catch (error) {
      core.setFailed(
        `Could not authenticate with PAT. Please check that it is correct and that it has [read access] to the organization or user account: ${error}`
      )
      return
    }

    const repos = await findAllRepos(octokit, user, organization)
    console.log(`Found [${repos.length}] repositories`)

    let actionFiles = await findAllActions(octokit, repos, isEnterpriseServer)
    // load the information in the files
    actionFiles = await enrichActionFiles(octokit, actionFiles)

    // output the json we want to output
    const output: {
      lastUpdated: string
      organization: string
      user: string
      actions: Content[]
    } = {
      lastUpdated: GetDateFormatted(new Date()),
      actions: actionFiles,
      organization,
      user
    }

    const json = JSON.stringify(output)
    core.setOutput('actions', json)
  } catch (error) {
    core.setFailed(`Error running action: : ${error.message}`)
  }
}

export class Repository {
  name: string
  owner: string
  visibility: string
  constructor(owner: string, name: string, visibility: string) {
    this.name = name
    this.owner = owner
    this.visibility = visibility
  }
}

export class Content {
  name: string | undefined
  owner: string | undefined
  repo: string | undefined
  downloadUrl: string | undefined
  author: string | undefined
  description: string | undefined
  forkedfrom: string | undefined
  readme: string | undefined
}

async function findAllActions(
  client: Octokit,
  repos: Repository[],
  isEnterpriseServer: boolean
): Promise<Content[]> {
  const result: Content[] = []

  // search all repos for actions
  for (const repo of repos) {
    core.debug(`Searching repository for actions: ${repo.name}`)
    let content = await getActionFile(client, repo, isEnterpriseServer)
    if (removeTokenSetting && content) {
      content = removeToken(content)
    }
    if (fetchReadmesSetting && content) {
      const readmeLink = await getReadmeContent(client, repo)
      if (readmeLink) {
        content.readme = readmeLink
      }
    }
    if (content && content.name) {
      core.info(
        `Found action file in repository: [${repo.name}] with filename [${content.name}] download url [${content.downloadUrl}]. Visibility of repo is [${repo.visibility}]`
      )

      // Check the actions if its internal for the workflow access settings:
      if (repo.visibility == 'internal') {
        core.debug(
          `Get access settings for repository [${repo.owner}/${repo.name}]..............`
        )
        try {
          const {data: accessSettings} =
            await client.rest.actions.getWorkflowAccessToRepository({
              owner: repo.owner,
              repo: repo.name
            })

          if (accessSettings.access_level == 'none') {
            core.info(
              `Access to use action [${repo.owner}/${repo.name}] is disabled`
            )
            continue
          }
        } catch (error) {
          core.info(
            `Error retrieving acces level for the action(s) in [${repo.owner}/${repo.name}]. Make sure the Access Token used has the 'Administration: read' scope. Error: ${error.message}`
          )
          continue
        }
      } else if (repo.visibility == 'private') {
        core.debug(`[${repo.owner}/${repo.name}] is private repo, skipping.`)
        continue
      }

      result.push(content)
    }
  }

  console.log(`Found [${result.length}] actions in [${repos.length}] repos`)
  return result
}

async function getActionFile(
  client: Octokit,
  repo: Repository,
  isEnterpriseServer: boolean
): Promise<Content | null> {
  const result = new Content()

  const {data: repoinfo} = await client.rest.repos.get({
    owner: repo.owner,
    repo: repo.name
  })
  let parentinfo = ''
  if (repoinfo.parent?.full_name) {
    parentinfo = repoinfo.parent.full_name
  }

  // search for action.yml file in the root of the repo
  try {
    const {data: yml} = await client.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path: 'action.yml'
    })

    // todo: warning: duplicated code here
    if ('name' in yml && 'download_url' in yml) {
      result.name = yml.name
      result.owner = repo.owner
      result.repo = repo.name
      result.forkedfrom = parentinfo

      if (yml.download_url !== null) {
        result.downloadUrl = yml.download_url
      }
    }
  } catch (error) {
    core.debug(`No action.yml file found in repository: ${repo.name}`)
  }

  if (!result.name) {
    try {
      // search for the action.yaml, that is also allowed
      const {data: yaml} = await client.rest.repos.getContent({
        owner: repo.owner,
        repo: repo.name,
        path: 'action.yaml'
      })

      if ('name' in yaml && 'download_url' in yaml) {
        result.name = yaml.name
        result.owner = repo.owner
        result.repo = repo.name
        result.forkedfrom = parentinfo
        if (yaml.download_url !== null) {
          result.downloadUrl = yaml.download_url
        }
      }
    } catch (error) {
      core.debug(`No action.yaml file found in repository: ${repo.name}`)
    }
  }

  // todo: ratelimiting can be enabled on GHES as well, but is off by default
  // we can probably load it from an api call and see if it is enabled, or try .. catch
  if (!isEnterpriseServer) {
    // search API has a strict rate limit, prevent errors
    var ratelimit = await client.rest.rateLimit.get()
    if (ratelimit.data.resources.search.remaining <= 2) {
      // show the reset time
      var resetTime = new Date(ratelimit.data.resources.search.reset * 1000)
      core.debug(`Search API reset time: ${resetTime}`)
      // wait until the reset time
      var waitTime = resetTime.getTime() - new Date().getTime()
      if (waitTime < 0) {
        // if the reset time is in the past, wait 2,5 seconds for good measure (Search API rate limit is 30 requests per minute)
        waitTime = 2500
      } else {
        // back off a bit more to be more certain
        waitTime = waitTime + 1000
      }
      core.info(
        `Waiting ${
          waitTime / 1000
        } seconds to prevent the search API rate limit`
      )
      await new Promise(r => setTimeout(r, waitTime))
    }
  }
  if (!result.name) {
    core.info(`No actions found at root level in repository: ${repo.name}`)
    core.info(`Checking subdirectories in repository: ${repo.name}`)
    var searchQuery =
      '+filename:action+language:YAML+repo:' + repo.owner + '/' + repo.name

    var searchResultforRepository = await client.request('GET /search/code', {
      q: searchQuery
    })

    if (Object.keys(searchResultforRepository.data.items).length > 0) {
      for (
        let index = 0;
        index < Object.keys(searchResultforRepository.data.items).length;
        index++
      ) {
        var element = searchResultforRepository.data.items[index].path
        const {data: yaml} = await client.rest.repos.getContent({
          owner: repo.owner,
          repo: repo.name,
          path: element
        })
        if ('name' in yaml && 'download_url' in yaml) {
          result.name = yaml.name
          result.repo = repo.name
          result.forkedfrom = parentinfo
          if (yaml.download_url !== null) {
            result.downloadUrl = yaml.download_url
          }
        }
      }
      return result
    }

    core.info(`No actions found in repository: ${repo.name}`)
    return null
  }

  return result
}

async function enrichActionFiles(
  client: Octokit,
  actionFiles: Content[]
): Promise<Content[]> {
  for (const action of actionFiles) {
    // download the file in it and parse it
    if (action.downloadUrl !== null) {
      const {data: content} = await client.request({url: action.downloadUrl})

      // try to parse the yaml
      try {
        const parsed = YAML.parse(content)
        const defaultValue = 'Undefined' // Default value when json field is not defined
        action.name = parsed.name ? parsed.name : defaultValue
        action.author = parsed.author ? parsed.author : defaultValue
        action.description = parsed.description
          ? parsed.description
          : defaultValue
      } catch (error) {
        // this happens in https://github.com/gaurav-nelson/github-action-markdown-link-check/blob/9de9db77de3b29b650d2e2e99f0ee290f435214b/action.yml#L9
        // because of invalid yaml
        console.log(
          `Error parsing action file in repo [${action.repo}] with error:`
        )
        console.log(error)
        console.log(
          `The parsing error is informational, seaching for actions has continued`
        )
      }
    }
  }
  return actionFiles
}

run()
