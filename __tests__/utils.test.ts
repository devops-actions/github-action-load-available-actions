import {expect, test} from '@jest/globals'
import {GetDateFormatted} from '../src/utils'
import {parseYAML} from '../src/utils'
import {sanitize} from '../src/utils'

test('date parsing', () => {
    const date = new Date(2021, 0, 16, 11, 43, 0, 0)
    const result = GetDateFormatted(date)

    expect(result).toHaveLength(13)
    expect(result).toMatch('20210116_1143')
})
  
test(`check parseYAML with normal strings`, () => {
    const content = `
  name: 'test-name'
  author: 'test-author'
  description: 'testing'
  runs:\n    using: 'test'`
    const filePath = 'test'
    const result = parseYAML(filePath, 'test', content)
  
    expect(result.name).toBe('testname')
    expect(result.author).toBe('testauthor')
    expect(result.description).toBe('testing')
    expect(result.using).toBe('test')
  })
  
test(`check parseYAML with quoted strings`, () => {
    const content = `
  name: 'test "name"'
  author: 'test "author"'
  description: 'testing "with quotes"'
  runs:\n    using: 'testwithquote"'
  `

    const filePath = 'test'
    const result = parseYAML(filePath, 'test', content)
  
    expect(result.name).toBe('test name')
    expect(result.author).toBe('test author')
    expect(result.description).toBe('testing with quotes')
    expect(result.using).toBe('testwithquote')
  })

test(`Check sanitization`, () => {
    const value = "Abc$%#6- ZZpp"
    const cleaned = sanitize(value)
    expect(cleaned).toBe("Abc6 ZZpp")
})

test(`test parseYAML from composite test file`, () => {
  // load a file from the tests directory
  const filePath = '__tests__/parseYAML/composite_action.yml'
  const content = require('fs').readFileSync(filePath, 'utf8')
  const result = parseYAML(filePath, 'test', content)

  expect(result.name).toBe('🔍️ PR Name Validation')
  expect(result.author).toBe('Andreas Dukstad  Arne Kristian Jansen')  // & is currently eaten up
  expect(result.description).toBe('This action will validate the name of a PR ensuring it follows the expected naming rules') // comma and period are currently eaten up
  expect(result.using).toBe('composite')

  expect(result.steps.actions).toHaveLength(2)
  expect(result.steps.shell).toHaveLength(4)

  let action = result.steps.actions[0]
  expect(action.action).toBe("actions/checkout")
  expect(action.ref).toBe("v2")

  action = result.steps.actions[1]
  expect(action.action).toBe("amannn/action-semantic-pull-request")
  expect(action.ref).toBe("01d5fd8a8ebb9aafe902c40c53f0f4744f7381eb")
})

test(`test parseYAML from normal test file`, () => {
  // load a file from the tests directory
  const filePath = 'action.yml'
  const content = require('fs').readFileSync(filePath, 'utf8')
  const result = parseYAML(filePath, 'test', content)

  expect(result.name).toBe('Load available actions')
  expect(result.author).toBe('Rob Bos')
  expect(result.description).toBe('Load an overview of all available actions in a GitHub Organization by looking for the actionymlyaml files') // slash and period are currently eaten up
  expect(result.using).toBe('node16')

  expect(result.steps.actions).toHaveLength(0)
  expect(result.steps.shell).toHaveLength(0)
})