import * as core from '@actions/core'
import {execSync} from 'child_process'
import moment from 'moment'
import string from 'string-sanitizer'
import YAML from 'yaml'
import {promisify} from 'util'
import fs from 'fs'
export function GetDateFormatted(date: Date): string {
  return moment(date).format('YYYYMMDD_HHmm')
}

export function parseYAML(
  filePath: string,
  repo: string | undefined,
  content: string
): any {
  const defaultValue = 'Undefined' // Default value when json field is not defined
  let name = defaultValue
  let author = defaultValue
  let description = defaultValue
  let using = description

  let parsed: any
  let steps: any
  try {
    parsed = YAML.parse(content)
    name = parsed.name ? sanitize(parsed.name) : defaultValue
    author = parsed.author ? sanitize(parsed.author) : defaultValue
    description = parsed.description
      ? sanitize(parsed.description)
      : defaultValue

    if (parsed.runs) {
      using = parsed.runs.using ? sanitize(parsed.runs.using) : defaultValue
    }

    steps = parseSteps(parsed)
  } catch (error) {
    // this happens in https://github.com/gaurav-nelson/github-action-markdown-link-check/blob/9de9db77de3b29b650d2e2e99f0ee290f435214b/action.yml#L9
    // because of invalid yaml
    core.warning(
      `Error parsing action file [${filePath}] in repo [${repo}] with error: ${
        error as Error
      }`
    )
    core.info(
      `The parsing error is informational, seaching for actions has continued`
    )
  }

  return {name, author, description, using, steps}
}

function splitUsesStatement(uses: string): {action:string, ref:string} {
  const split = uses.split('@')
  const action = split[0]
  const ref = split[1]
  return {action, ref}
}

function parseSteps(parsed: any): {actions: {action:string, ref:string}[], shell: string[]} {
  const actions: {action:string, ref:string}[] = []
  const shell: string[] = []
  if (parsed && parsed.runs && parsed.runs.steps) {
    parsed.runs.steps.forEach((step: any) => {
      if (step.uses) {
        // todo: convert multiple uses statements into single action with count
        const uses = splitUsesStatement(step.uses)
        actions.push(uses)
      }
      if (step.run) {
        shell.push(step.name)
      }
    })
  }
  return {actions, shell}
}

export function sanitize(value: string) {
  return string.sanitize.keepSpace(value)
}

// Interface for a Dockerfile with actionable properties
export interface DockerActionFiles {
  [key: string]: string | undefined
  name?: string
  description?: string
  author?: string
  repo?: string
  downloadUrl?: string
  // icon?: string
  // color?: string

  // Icon and color is needed for using dockerfiles as actions, but it's not used in the marketplace.
}

export const getActionableDockerFilesFromDisk = async (path: string) => {
  const dockerFilesWithActionArray: DockerActionFiles[] = []
  const dockerFiles = execSync(
    `find ${path} -name "Dockerfile" -o -name "dockerfile"`,
    {encoding: 'utf8'}
  ).split('\n')
  // Asynchronously process each Dockerfile
  await Promise.all(
    dockerFiles.map(async (item: string) => {
      // If the Dockerfile path is valid
      if (item) {
        // Remove the "actions/${path}/" prefix from the path
        item = item.replace(`actions/${path}/`, '')

        try {
          // Read the contents of the Dockerfile
          const data = await promisify(fs.readFile)(item, 'utf8')
          const label = 'LABEL com.github.actions.'
          // Check if the Dockerfile has actionable properties
          if (
            data.includes(`${label}name=`) &&
            data.includes(`${label}description=`)
          ) {
            core.info(`[${item}] has dockerfile as an action!`)

            // Extract the actionable properties from the Dockerfile
            const splitText = data.split('\n')
            const dockerActionFile: DockerActionFiles = {}
            splitText.forEach((line: string) => {
              if (line.startsWith('LABEL com.github.actions.')) {
                const type = line.split('.')[3].split('=')[0]
                const data = line.split('"')[1]
                dockerActionFile[type] = data
              }
            })

            core.info(`Pushing: ${JSON.stringify(dockerActionFile)}`)
            dockerFilesWithActionArray.push(dockerActionFile)
          }
        } catch (err) {
          core.info(String(err))
        }
      }
    })
  )
  return dockerFilesWithActionArray
}
