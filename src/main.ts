import * as core from '@actions/core'
import {Octokit} from 'octokit'
import {
  DockerActionFiles,
  GetDateFormatted,
  getActionableDockerFilesFromDisk
} from './utils'
import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import {getReadmeContent} from './optionalActions'
import {parseYAML} from './utils'
import {execSync} from 'child_process'
import {Buffer} from "buffer"
import YAML from 'yaml'

dotenv.config()

const getInputOrEnv = (input: string) =>
  core.getInput(input) || process.env[input] || ''

function getHostName(): string {
  const hostName = process.env['GITHUB_SERVER_URL'] || 'github.com'
  return hostName
}

//Optional values
const removeTokenSetting = getInputOrEnv('removeToken')
const fetchReadmesSetting = getInputOrEnv('fetchReadmes')
const hostname = getHostName()
const scanForReusableWorkflows = getInputOrEnv('scanForReusableWorkflows')
const includePrivateWorkflows = getInputOrEnv('includePrivateWorkflows')

async function run(): Promise<void> {
  core.info('Starting')
  try {
    const PAT = getInputOrEnv('PAT')
    const user = getInputOrEnv('user')
    const organization = getInputOrEnv('organization')
    const baseUrl = process.env.GITHUB_API_URL || 'https://api.github.com'
    const isEnterpriseServer = baseUrl !== 'https://api.github.com'
    const outputFilename = getInputOrEnv('outputFilename') || 'actions.json'

    if (!PAT) {
      core.setFailed(
        "Parameter 'PAT' is required to load all actions from the organization or user account"
      )
      return
    }

    if (!user && !organization) {
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
      // this call fails from a GitHub App token, so we need a better way to validate this
      //const currentUser = await octokit.rest.users.getAuthenticated()
      //core.info(`Hello, ${currentUser.data.login}`)
    } catch (error) {
      core.setFailed(
        `Could not authenticate with PAT. Please check that it is correct and that it has [read access] to the organization or user account: ${error}`
      )
      return
    }

    let actionFiles = await getAllActions(octokit, user, organization, isEnterpriseServer)
    let workflows: WorkflowContent[] = []
    
    if (scanForReusableWorkflows === 'true') {
      workflows = await getAllReusableWorkflowsUsingSearch(octokit, user, organization, isEnterpriseServer)
    }

    // output the json we want to output
    const output: {
      lastUpdated: string
      organization: string
      user: string
      actions: ActionContent[]
      workflows: WorkflowContent[]
    } = {
      lastUpdated: GetDateFormatted(new Date()),
      actions: actionFiles,
      workflows: workflows,
      organization,
      user
    }

    // log the number of actions found
    core.info(`Found [${actionFiles.length}] actions`)
    const json = JSON.stringify(output)
    fs.writeFileSync(outputFilename, json)
    const fullPath = path.resolve(outputFilename)
    core.info(`Writing results to [${fullPath}]`)

    core.setOutput('actions-file-path', fullPath)
  } catch (error: any) {
    core.setFailed(`Error running action: : ${error.message}`)
  }
}

export class ActionContent {
  name: string | undefined
  owner: string | undefined
  repo: string | undefined
  downloadUrl: string | undefined
  author: string | undefined
  description: string | undefined
  forkedfrom: string | undefined
  readme: string | undefined
  using: string | undefined
  isArchived: boolean | undefined
  steps: any | undefined
}

export class WorkflowContent {
  name: string | undefined
  repo: string | undefined
  downloadUrl: string | undefined
  description: string | undefined
  forkedfrom: string | undefined
  isArchived: boolean | undefined
  visibility: string | undefined
}

async function getAllActions(
  client: Octokit, 
  user: string,
  organization: string,
  isEnterpriseServer: boolean) : Promise<ActionContent[]> {

  // get all action files (action.yml and action.yaml) from the user or organization
  let actionFiles = await getAllNormalActions(client, user, organization, isEnterpriseServer)
  // load the information inside of the action definition files
  actionFiles = await enrichActionFiles(client, actionFiles)

  // get all docker action definition (Dockerfile / dockerfile) from the user or organization
  const allActionableDockerFiles = await getActionableDockerFiles(client, user, organization, isEnterpriseServer )
  core.info(`Found [${allActionableDockerFiles.length}] docker files with action definitions`)

  // concat the arrays before we return them in one go
  const actionFilesToReturn = actionFiles.concat(allActionableDockerFiles)

  return actionFilesToReturn
}

async function enrichActionFiles(
  client: Octokit,
  actionFiles: ActionContent[]
): Promise<ActionContent[]> {
  for (const action of actionFiles) {
    core.debug(`Enrich action information from file: [${action.downloadUrl}]`)
    // download the file in it and parse it
    if (action.downloadUrl) {
      const {data: content} = await client.request({url: action.downloadUrl})

      // try to parse the yaml
      const {name, author, description, using, steps} = parseYAML(
        action.downloadUrl,
        action.repo,
        content
      )
      action.name = name
      action.author = author
      action.description = description
      action.using = using
      action.steps = steps
    }
  }
  return actionFiles
}

const getSearchResult = async (
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean,
  searchQuery: string
) => {
  if (username) {
    core.info(
      `Search for action files of the user [${username}] in forked repos`
    )
    searchQuery = searchQuery.concat('+user:', username)
  }

  if (organization !== '') {
    core.info(
      `Search for action files under the organization [${organization}] in forked repos with the query [${searchQuery}]`
    )
    searchQuery = searchQuery.concat('+org:', organization)
  }
  let searchResult
  if (searchQuery.includes('fork')) {
    searchResult = await executeRepoSearch(client, searchQuery, isEnterpriseServer)
  } else {
    searchResult = await executeCodeSearch(client, searchQuery, isEnterpriseServer)
  }
  return searchResult
}

async function checkRateLimits(client: Octokit, isEnterpriseServer: boolean, limitToSearch: boolean = false) {
  // ratelimiting can be enabled on GHES as well, but is off by default
  // we load it from an api call and see if it is enabled, wrapped with try .. catch to handle the error
  var ratelimit
  if (isEnterpriseServer) {
    // this call will give a 404 on GHES when ratelimit is not enabled
    try {
      ratelimit = await client.rest.rateLimit.get()
    } catch (error) {
      // handle the 404
      if ((error as Error).message === 'Not Found') {
        core.info('Rate limit is not enabled on this GitHub Enterprise Server instance. Skipping rate limit checks.')
        return
      }
    }
  } else {
    // search API has a strict rate limit, prevent errors
    ratelimit = await client.rest.rateLimit.get()
  }

  if (ratelimit) {
    core.debug(`Rate limit info: ${JSON.stringify(ratelimit.data.resources)}`)
    // show the reset time
    let resetTime
    if (limitToSearch && ratelimit.data.resources.search.remaining <= 2) {
      resetTime = new Date(ratelimit.data.resources.search.reset * 1000)
    }
    else {
      if (ratelimit.data.resources.core.remaining <= 2) {
        resetTime = new Date(ratelimit.data.resources.core.reset * 1000)
      }
      else {
        // no need to wait
        return
      }
    }
    core.debug(`Search API reset time: ${resetTime}, backing off untill then`)
    core.debug(`Search ratelimit info: ${JSON.stringify(ratelimit.data.resources.search)}`)
    // wait until the reset time
    var waitTime = resetTime.getTime() - new Date().getTime()
    if (waitTime < 0) {
      // if the reset time is in the past, wait 6 seconds for good measure (Search API rate limit is 10 requests per minute)
      waitTime = 7000
    } else {
      // back off a bit more to be more certain
      waitTime = waitTime + 1000
    }
    core.info(
      `Waiting ${waitTime / 1000} seconds to prevent the search API rate limit`
    )
    await new Promise(r => setTimeout(r, waitTime))
  }
}

async function getAllNormalActions(
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean
): Promise<ActionContent[]> {
  let actions = await getAllActionsUsingSearch(client, username, organization, isEnterpriseServer)
  // search does not work on forked repos, so we need to loop over all forks manually
  let forkedActions = await getAllActionsFromForkedRepos(client, username, organization, isEnterpriseServer)

  actions = actions.concat(forkedActions)
  core.debug(`Found [${actions.length}] actions in total`)

  // deduplicate the actions list
  actions = actions.filter(
    (action, index, self) =>
      index ===
      self.findIndex(
        t => `${t.name} ${t.repo}` === `${action.name} ${action.repo}`
      )
  )
  core.debug(`After dedupliation we have [${actions.length}] actions in total`)
  return actions
}

async function getActionableDockerFiles(
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean
): Promise<ActionContent[]> {
  let dockerActions: DockerActionFiles[] | undefined = []
  let actions: ActionContent[] = []
  const searchResult = await getSearchResult(client, username, organization, isEnterpriseServer, '+fork:only')

  core.info(`Found [${searchResult.length}] repos, checking only the forks`)

  for (let index = 0; index < searchResult.length; index++) {
    const repo = searchResult[index]

    if (!repo.fork) {
      // we only want forked repos
      continue
    }

    // check if the repo contains action files in the root of the repo
    const repoName = repo.name
    const repoOwner = repo.owner ? repo.owner.login : ''

    core.debug(`Checking repo [${repoName}] for action files`)
    // clone the repo
    const repoPath = cloneRepo(repoName, repoOwner)
    if (!repoPath) {
      // error cloning the repo, skip it
      continue
    }
    
    const actionableDockerFiles = await getActionableDockerFilesFromDisk(repoPath)


    if (JSON.stringify(actionableDockerFiles) !== '[]') {
      core.info(`adding ${JSON.stringify(actionableDockerFiles)}`)
      actionableDockerFiles?.map(item => {
        item.author = repoOwner
        item.repo = repoName
        item.downloadUrl = `https://${hostname}/${repoOwner}/${repoName}.git`
      })
      dockerActions = actionableDockerFiles
    }
  }

  dockerActions?.forEach((value, index) => {
    actions[index] = new ActionContent()
    actions[index].name = value.name
    actions[index].repo = value.repo
    actions[index].forkedfrom = ''
    actions[index].downloadUrl = value.downloadUrl
    actions[index].author = value.author
    actions[index].description = value.description
    actions[index].using = 'docker'
  })
  return actions
}

async function getAllActionsFromForkedRepos(
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean
): Promise<ActionContent[]> {
  const actions: ActionContent[] = []
  const searchResult = await getSearchResult(client, username, organization, isEnterpriseServer, '+fork:only')
  core.info(`Found [${searchResult.length}] repos, checking only the forks`)
  for (let index = 0; index < searchResult.length; index++) {
    const repo = searchResult[index]
    
    if (!repo.fork) {
      // we only want forked repos
      continue
    }
    
    // check if the repo contains action files in the root of the repo
    const repoName = repo.name
    const repoOwner = repo.owner ? repo.owner.login : ''
    const isArchived = repo.archived

    core.debug(`Checking repo [${repoName}] for action files`)
    // clone the repo
    const repoPath = cloneRepo(repoName, repoOwner)
    if (!repoPath) {
      // error cloning the repo, skip it
      continue
    }
    // check with a shell command if the repo contains action files in the root of the repo
    const actionFiles = execSync(
      `find ${repoPath} -name "action.yml" -o -name "action.yaml"`,
      {encoding: 'utf8'}
    ).split('\n')
    core.debug(
      `Found [${
        actionFiles.length - 1
      }] action in repo [${repoName}] that was cloned to [${repoPath}]`
    )

    for (let index = 0; index < actionFiles.length - 1; index++) {
      core.debug(`Found action file [${actionFiles[index]}] in repo [${repoName}]`)

      // remove the actions/$repopath
      const actionFile = actionFiles[index].substring(`actions/${repoName}/`.length)
      core.debug(`Found action file [${actionFile}] in repo [${repoName}]`)

      // Get "Forked from" info for the repo
      const parentInfo = await getForkParent(repo)

      // get the action info
      const action = await getActionInfo(client, repoOwner, repoName, actionFile, parentInfo, isArchived)
      actions.push(action)
    }
  }

  return actions
}

function cloneRepo(repo: string, owner: string): string {
  try {
    const repolink = `https://${hostname}/${owner}/${repo}.git`
    // create a temp directory
    const repoPath = 'actions'
    if (fs.existsSync(repoPath)) {
      core.debug('folder already exists, deleting')
      fs.rmSync(repoPath, {recursive: true})
    }
    fs.mkdirSync(repoPath)

    core.debug(`Cloning repo [${repo}] to [${repoPath}]`)

    // clone the repo
    execSync(`git clone ${repolink}`, {
      stdio: [0, 1, 2], // we need this so node will print the command output
      cwd: repoPath // path to where you want to run the command
    })

    return path.join(repoPath, repo)
  } catch (error: any) {
    core.info(`Error cloning repo [${repo}]: ${error}`)
    // core.info(`Message: ${error?.stdout.toString()}`) // stdout is null
    return ''
  }
}

async function executeCodeSearch(
  client: Octokit,
  searchQuery: string,
  isEnterpriseServer: boolean,
): Promise<any> {

  try {
    core.debug(`searchQuery for code: [${searchQuery}]`)

    const searchResult = await paginateSearchQuery(client, searchQuery, isEnterpriseServer, false)

    core.debug(`Found [${searchResult.length}] code search results`)
    return searchResult
  } catch (error) {
    core.info(`executeCodeSearch: catch! Error is: ${error} with message ${(error as Error).message}` )
    if (
      (error as Error).message.includes('SecondaryRateLimit detected for request')
        || 
      (error as Error).message.includes('API rate limit exceeded for')
    ) {
    } else {
      core.info(`Error executing code search: ${error}`)
      throw error
    }
  }
}

async function callSearchQueryWithBackoff
(
  client: Octokit,
  searchQuery: string, 
  page: number, 
  isEnterpriseServer: boolean,
  searchRepos: boolean
): Promise<any>
{
  try {
    core.debug(`Calling the search API with query [${searchQuery}] and page [${page}] `)
    let results
    if (searchRepos) {
      results = await client.rest.search.repos({q: searchQuery, per_page: 100, page})
    }
    else {      
      results = await client.rest.search.code({q: searchQuery, per_page: 100, page})
    }
    return results.data
  }
  catch (error) {
    // log the error
    core.info(`Error calling the search API with query [${searchQuery}] and page [${page}] `)
    // check if we hit the rate limit
    if ((error as Error).message.includes('API rate limit exceeded for')) {
      // todo: backoff and retry
      checkRateLimits(client, isEnterpriseServer, true)
      return callSearchQueryWithBackoff(client, searchQuery, page, isEnterpriseServer, searchRepos)
    }
    
    if ((error as Error).message.includes('Cannot access beyond the first 1000 results')) {
      return null
    }

    // if we get to here:
    throw error    
  }
}

async function paginateSearchQuery(client: Octokit, searchQuery: string, isEnterpriseServer: boolean, searchRepos: boolean) {
  var page = 1
  var total_count = 0
  var items: any[] = []
  do {
    var response = await callSearchQueryWithBackoff(client, searchQuery, page, isEnterpriseServer, searchRepos)
    if (response) {
      total_count = response.total_count
      items = items.concat(response.items)
      core.debug(`Found [${items.length}] results so far`)
      if (items.length >= 1000) {
        // API will return: 'Cannot access beyond the first 1000 results'
        core.warning(`Found [${items.length}] results, API does not give more results, stopping search and returning the first 1000 results`)
        return items
      }
      page++
      // code endpoint has a ratelimit of 10 calls a minute, so wait 6 seconds between calls
      await new Promise(r => setTimeout(r, 6000))
    }
    else {
      // no more results
      return items
    }
  } while (items.length < total_count)
  return items
}

async function executeRepoSearch(
  client: Octokit,
  searchQuery: string,
  isEnterpriseServer: boolean
): Promise<any> {
  
  try {
    core.debug(`searchQuery for repos: [${searchQuery}]`)
    const searchResult = await paginateSearchQuery(client, searchQuery, isEnterpriseServer, true)
    core.debug(`Found [${searchResult.length}] repo search results`)
    return searchResult
  } catch (error) {
    core.info(`executeRepoSearch: catch!`)
    if (
      (error as Error).message.includes('SecondaryRateLimit detected for request')
       ||
      (error as Error).message.includes(`API rate limit exceeded for`)
      ||
      (error as Error).message.includes(`You have exceeded a secondary rate limit`)
    ) {      
      return []
    } else {
      core.error(`Error executing repo search: ${error} with message ${(error as Error).message}`)
      return []
    }
  }
}

// Get the Details of a Repository
async function getRepoDetails(
  client: Octokit,
  owner: string,
  repo: string
): Promise<any> {
    const {data: repoDetails} = await client.rest.repos.get({
      owner,
      repo,
    });

    return repoDetails
}

async function getAllActionsUsingSearch(
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean
): Promise<ActionContent[]> {
  const actions: ActionContent[] = []
  
  const searchResult = await getSearchResult(
    client,
    username,
    organization,
    isEnterpriseServer,
    '+filename:action+language:YAML'
  )

  for (let index = 0; index < searchResult.length; index++) {
    checkRateLimits(client, isEnterpriseServer)

    const fileName = searchResult[index].name
    const filePath = searchResult[index].path
    const repoName = searchResult[index].repository.name
    const repoOwner = searchResult[index].repository.owner.login

    // Push file to action list if filename matches action.yaml or action.yml
    if (fileName == 'action.yaml' || fileName == 'action.yml') {
      core.info(`Found action in ${repoName}/${filePath}`)

      // Get the Repository Details
      const repoDetail = await getRepoDetails(client, repoOwner, repoName)
      const isArchived = repoDetail.archived

      // Get "Forked from" info for the repo
      let parentInfo = ''

      if (searchResult[index].repository.fork) {
        parentInfo = await getForkParent(repoDetail)
      }

      const result = await getActionInfo(
        client,
        repoOwner,
        repoName,
        filePath,
        parentInfo,
        isArchived
      )
      actions.push(result)
    }
  }
  return actions
}

async function getForkParent(
  repoDetails: any,
): Promise<string> {

  let parentInfo = ''
  if (repoDetails.parent?.full_name) {
    parentInfo = repoDetails.parent.full_name
  }

  return parentInfo
}

async function getActionInfo(
  client: Octokit,
  owner: string,
  repo: string,
  path: string,
  forkedFrom: string,
  isArchived: boolean = false
): Promise<ActionContent> {
  
  // Get File content
  const {data: yaml} = await client.rest.repos.getContent({
    owner,
    repo,
    path
  })

  const result = new ActionContent()
  if ('name' in yaml && 'download_url' in yaml) {
    result.name = yaml.name
    result.repo = repo
    result.forkedfrom = forkedFrom
    result.isArchived = isArchived
    if (yaml.download_url !== null) {
      result.downloadUrl = removeTokenSetting
        ? yaml.download_url.replace(/\?(.*)/, '')
        : yaml.download_url
    }
  }

  if (fetchReadmesSetting && yaml) {
    const readmeLink = await getReadmeContent(client, repo, owner)
    if (readmeLink) {
      result.readme = readmeLink
    }
  }

  return result
}


/*
  Workflows
*/



/*
 Search for Reusable workflows and return a array with workflow details
*/
async function getAllReusableWorkflowsUsingSearch(
  client: Octokit,
  username: string,
  organization: string,
  isEnterpriseServer: boolean
): Promise<WorkflowContent[]> {
  const workflows: WorkflowContent[] = []
  
  const searchResult = await getSearchResult(
    client,
    username,
    organization,
    isEnterpriseServer,
    '+path:.github/workflows+extension:yml+workflow_call in:file'
  )

  for (let index = 0; index < searchResult.length; index++) {
    checkRateLimits(client, isEnterpriseServer)

    const fileName = searchResult[index].name
    const filePath = searchResult[index].path
    const repoName = searchResult[index].repository.name
    const repoOwner = searchResult[index].repository.owner.login

    // Get the Repository Details
    const repoDetail = await getRepoDetails(client, repoOwner, repoName)
    const isArchived = repoDetail.archived
    const visibility = repoDetail.visibility

    // Skip workflow if it is a private repo
    if ( includePrivateWorkflows === 'false' && visibility === 'private') {
      continue
    }

    core.info(`Found workflow ${fileName } in ${repoName}/${filePath}`)

    const result = await getWorkflowInfo(
      client,
      repoOwner,
      repoName,
      filePath,
      isArchived,
      visibility
    )

    workflows.push(result)
  }

  return workflows
}

/*
 Read the workflow file and return some details 
*/
async function getWorkflowInfo(
  client: Octokit,
  owner: string,
  repo: string,
  path: string,
  isArchived: boolean = false,
  visibility: string
): Promise<WorkflowContent> {
  
  // Get File content
  const {data: yaml} = await client.rest.repos.getContent({
    owner,
    repo,
    path
  })

  // Decode the content (workflow)
  const decodeContent = (str: string):string => Buffer.from(str, 'base64').toString('binary');
  const content = decodeContent(yaml.content)
  const workflowYaml = YAML.parse(content)
  
  // Set the Results
  const result = new WorkflowContent()

  if(workflowYaml.name) {
    result.name = workflowYaml.name
  }else {
    result.name = yaml.name.replace('.yml', '')
  }

  result.repo = repo
  result.isArchived = isArchived
  result.visibility = visibility
  
  if (yaml.download_url !== null) {
    result.downloadUrl = removeTokenSetting
      ? yaml.download_url.replace(/\?(.*)/, '')
      : yaml.download_url
  }

  return result
}



run()
