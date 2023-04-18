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

  try {
    const parsed = YAML.parse(content)
    name = parsed.name ? sanitize(parsed.name) : defaultValue
    author = parsed.author ? sanitize(parsed.author) : defaultValue
    description = parsed.description
      ? sanitize(parsed.description)
      : defaultValue
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
  return {name, author, description}
}

function sanitize(value: string) {
  return string.sanitize.keepSpace(value)
}

export const returnActionableDockerFiles = async (path: string) => {
  interface dockerActionFiles {
    [key: string]: string | undefined
    name?: string
    description?: string
    icon?: string
    color?: string
  }
  let dockerFilesWithAction: dockerActionFiles[] = []
  const dockerFiles = execSync(
    `
    find ${path} -name "Dockerfile" -o -name "dockerfile"`,
    {encoding: 'utf8'}
  ).split('\n')
  await Promise.all(
    dockerFiles.map(async item => {
      if (item) {
        item = item.replace(`actions/${path}/`, '')
        try {
          const data = await promisify(fs.readFile)(item, 'utf8')
          if (data.includes('LABEL com.github.actions.name=')) {
            core.info(`${item} has dockerfile as an action!`)
            const splitText = data.split('\n')
            const dockerActionFile: dockerActionFiles = {}
            splitText.forEach((line: string) => {
              if (line.startsWith('LABEL com.github.actions.')) {
                const type = line.split('.')[3].split('=')[0]
                const data = line.split('"')[1]
                dockerActionFile[type] = data
              }
            })
            core.info(`Pushing: ${JSON.stringify(dockerActionFile)}`)
            dockerFilesWithAction.push(dockerActionFile)
          }
        } catch (err) {
          core.info(String(err))
        }
      }
    })
  )
  return dockerFilesWithAction
}