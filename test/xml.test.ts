import { describe, it, expect } from 'vitest'
import { getXmlPayload, getXmlTag, getXmlChildren } from '../src/prompts/xml.js'

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

  it('returns first match for duplicate tags', () => {
    expect(getXmlTag('<title>First</title><title>Second</title>', 'title')).toBe('First')
  })

  it('ignores a trailing unclosed occurrence', () => {
    expect(getXmlTag('<title>Real</title> then <title>cut off', 'title')).toBe('Real')
  })

  it('reads a tag that carries attributes', () => {
    expect(getXmlTag('<title lang="en">Hello</title>', 'title')).toBe('Hello')
  })

  it('does not treat a longer tag name or a self-closing tag as an open tag', () => {
    expect(getXmlTag('<titles>No</titles><title/>x<title>Yes</title>', 'title')).toBe('Yes')
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

  it('reads children that carry attributes', () => {
    const xml = '<facts lang="en"><fact id="1">One</fact><fact>Two</fact></facts>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['One', 'Two'])
  })

  it('returns empty for invalid parent tag name', () => {
    expect(getXmlChildren('<facts><fact>A</fact></facts>', '.*', 'fact')).toEqual([])
  })

  // #472: models sometimes close an item with the wrong tag; the lazy match
  // then fused it with the next item and stored the stray tag in the field.
  it('splits an item closed with the wrong tag from the next one', () => {
    const xml = '<concepts><concept>VAAPI renderD128</color>\n    <concept>Jellyfin acceleration</concept></concepts>'
    expect(getXmlChildren(xml, 'concepts', 'concept')).toEqual(['VAAPI renderD128', 'Jellyfin acceleration'])
  })

  it('keeps a last item closed with the wrong tag', () => {
    const xml = '<concepts><concept>CPAL</concept><concept>alsa.headroom</cpu>\n</concepts>'
    expect(getXmlChildren(xml, 'concepts', 'concept')).toEqual(['CPAL', 'alsa.headroom'])
  })

  it('preserves nested markup with the same child tag', () => {
    const xml = '<facts><fact>Use <fact>inner</fact> here</fact><fact>Next</fact></facts>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['Use <fact>inner</fact> here', 'Next'])
  })

  it('ignores child delimiters inside CDATA, comments and processing instructions', () => {
    const item = '<![CDATA[<fact>]]><!-- </fact><fact> --><?example <fact>?>Value'
    expect(getXmlChildren(`<facts><fact>${item}</fact></facts>`, 'facts', 'fact')).toEqual([item])
  })

  it('drops inter-item comments after a mismatched close', () => {
    const xml = '<facts><fact>First</typo><!-- note --><fact>Next</fact></facts>'
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['First', 'Next'])
  })

  it('keeps inline markup inside a properly closed item', () => {
    const xml = '<decisions><decision>Wrap it in <code>x</code></decision></decisions>'
    expect(getXmlChildren(xml, 'decisions', 'decision')).toEqual(['Wrap it in <code>x</code>'])
  })
})

describe('getXmlPayload', () => {
  const quoting = [
    '<observation><type>file_read</type><title>Read index.html</title>',
    '<facts><fact>Page sets <title>Acme Home</title></fact></facts>',
    '<narrative>pom declares <type>jar</type> and lists <facts><fact>quoted</fact></facts></narrative>',
    '</observation>',
  ].join('')

  it('reads the first scalar field inside the root, not markup quoted later in the payload', () => {
    const xml = getXmlPayload(quoting, 'observation')
    expect(getXmlTag(xml, 'type')).toBe('file_read')
    expect(getXmlTag(xml, 'title')).toBe('Read index.html')
  })

  it('reads the first list inside the root, not one quoted in the narrative', () => {
    const xml = getXmlPayload(quoting, 'observation')
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['Page sets <title>Acme Home</title>'])
  })

  it('skips an example tag in prose before the root', () => {
    const response = [
      'I will use a format like <title>Example title</title> with <facts><fact>example</fact></facts>.',
      '<observation>',
      '  <type>file_read</type>',
      '  <title>Read src/foo.ts</title>',
      '  <facts><fact>One</fact><fact>Two</fact></facts>',
      '</observation>',
    ].join('\n')
    const xml = getXmlPayload(response, 'observation')
    expect(getXmlTag(xml, 'title')).toBe('Read src/foo.ts')
    expect(getXmlChildren(xml, 'facts', 'fact')).toEqual(['One', 'Two'])
  })

  it('takes the last complete root when an example root precedes it', () => {
    const response = 'Example: <summary><title>Example</title></summary>\n<summary><title>Real</title></summary>'
    expect(getXmlTag(getXmlPayload(response, 'summary'), 'title')).toBe('Real')
  })

  it('keeps a root the model quotes inside its own payload from becoming the payload', () => {
    const response = '<memory><title>Real</title><content>uses <memory><title>Quoted</title></memory> markup</content></memory>'
    expect(getXmlTag(getXmlPayload(response, 'memory'), 'title')).toBe('Real')
  })

  it('ignores a truncated root after the last complete one', () => {
    const response = '<summary><title>Done</title></summary><summary><title>cut'
    expect(getXmlTag(getXmlPayload(response, 'summary'), 'title')).toBe('Done')
  })

  it('accepts a root that carries attributes', () => {
    const response = 'note <title>x</title> <observation kind="a"><title>Real</title></observation>'
    expect(getXmlTag(getXmlPayload(response, 'observation'), 'title')).toBe('Real')
  })

  it('returns the whole response when no root is present', () => {
    const response = '<title>First</title><title>Second</title>'
    expect(getXmlPayload(response, 'observation')).toBe(response)
    expect(getXmlTag(getXmlPayload(response, 'observation'), 'title')).toBe('First')
  })
})
