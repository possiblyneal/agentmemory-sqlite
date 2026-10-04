import { describe, it, expect } from 'vitest'
import { getXmlTag, getXmlChildren } from '../src/prompts/xml.js'

describe('getXmlTag', () => {
  it('extracts simple tag content', () => {
    expect(getXmlTag('<title>Hello World</title>', 'title')).toBe('Hello World')
  })

  it('extracts multiline content', () => {
    expect(getXmlTag('<narrative>\nLine 1\nLine 2\n</narrative>', 'narrative')).toBe('Line 1\nLine 2')
  })

  it('returns empty string for missing tag', () => {
    expect(getXmlTag('<title>Hello</title>', 'missing')).toBe('')
  })

  it('returns the last complete occurrence for duplicate tags', () => {
    expect(getXmlTag('<title>First</title><title>Second</title>', 'title')).toBe('Second')
  })

  it('ignores a tag in prose written before the payload', () => {
    const response = [
      'I will use a format like <title>Example title</title> for this.',
      '<observation>',
      '  <type>file_read</type>',
      '  <title>Read src/foo.ts</title>',
      '</observation>',
    ].join('\n')
    expect(getXmlTag(response, 'title')).toBe('Read src/foo.ts')
  })

  it('ignores a trailing unclosed occurrence', () => {
    expect(getXmlTag('<title>Real</title> then <title>cut off', 'title')).toBe('Real')
  })

  it('returns empty string for empty tag', () => {
    expect(getXmlTag('<title></title>', 'title')).toBe('')
  })

  it('trims whitespace', () => {
    expect(getXmlTag('<title>  trimmed  </title>', 'title')).toBe('trimmed')
  })

  it('returns empty for invalid tag names', () => {
    expect(getXmlTag('<foo>bar</foo>', '.*')).toBe('')
  })

  it('returns empty for tag with special regex chars', () => {
    expect(getXmlTag('<foo>bar</foo>', 'a(b')).toBe('')
  })
})

describe('getXmlChildren', () => {
  it('extracts child elements', () => {
    const xml = '<facts><fact>One</fact><fact>Two</fact></facts>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['One', 'Two'])
  })

  it('returns empty array for missing parent', () => {
    expect(getXmlChildren('<foo>bar</foo>', 'facts', 'fact')).toEqual([])
  })

  it('returns empty array for missing children', () => {
    expect(getXmlChildren('<facts></facts>', 'facts', 'fact')).toEqual([])
  })

  it('trims child content', () => {
    const xml = '<facts><fact>  trimmed  </fact></facts>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['trimmed'])
  })

  it('handles multiline children', () => {
    const xml = '<decisions><decision>Use JWT\nfor auth</decision></decisions>'
    expect(getXmlChildren(xml, 'decisions', 'decision')).toEqual(['Use JWT\nfor auth'])
  })

  it('reads children of the last complete parent occurrence', () => {
    const xml = 'e.g. <facts><fact>example</fact></facts>\n<observation><facts><fact>One</fact><fact>Two</fact></facts></observation>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['One', 'Two'])
  })

  it('returns empty for invalid parent tag name', () => {
    expect(getXmlChildren('<facts><fact>A</fact></facts>', '.*', 'fact')).toEqual([])
  })
})
