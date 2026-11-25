import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isCanonicalOntologyIri, iriOwnershipKey } from '../src/index.js';

const ownershipKeys = (
    JSON.parse(readFileSync(new URL('./fixtures/iri-ownership-keys.json', import.meta.url), 'utf8')) as {
        readonly keys: ReadonlyArray<readonly [string, string]>;
    }
).keys;

describe('isCanonicalOntologyIri', () => {
    it.each([
        'https://example.test/ontology/core',
        'http://www.w3.org/ns/prov-o#',
        'https://example.test/%7euser',
        'urn:example:ontology',
        'foo://Host.Example/Path',
    ])('accepts the URL serialization %s', (value) => {
        expect(new URL(value).href).toBe(value);
        expect(isCanonicalOntologyIri(value)).toBe(true);
    });

    it.each([
        'https://sBPMN.github.io/2.0/',
        'https://sBPMN.github.io/2.0/classes#userTask',
        'https://EXAMPLE.TEST/ontology',
        'https://Example.test:8443/ontology',
        'http://[2001:DB8::1]/ontology',
    ])('accepts %s, which differs from its serialization only in the case of the host', (value) => {
        expect(new URL(value).href).not.toBe(value);
        expect(isCanonicalOntologyIri(value)).toBe(true);
    });

    it.each([
        ['scheme case', 'HTTPS://example.org/x'],
        ['scheme case with a mixed-case host', 'Https://Example.org/x'],
        ['a default port', 'https://example.org:443/x'],
        ['a default port with a mixed-case host', 'https://Example.org:443/x'],
        ['a user name with a mixed-case host', 'https://user@Example.test/'],
        ['a missing root path with a mixed-case host', 'https://Ex.org'],
        ['a dot segment with a mixed-case host', 'https://Ex.org/a/../b'],
        ['a percent-encoded host', 'https://%45x.org/'],
        ['a non-ASCII host', 'https://Bücher.example/'],
        ['a backslash for a slash', 'https:\\\\Ex.org/'],
        ['a space in the path', 'https://Ex.org/with space'],
        ['a relative reference', 'relative/ontology'],
        ['nothing', ''],
    ])('refuses %s: %s', (_reason, value) => {
        expect(isCanonicalOntologyIri(value)).toBe(false);
    });
});

describe('iriOwnershipKey', () => {
    it.each(ownershipKeys)('keys %s as %s', (value, key) => {
        expect(iriOwnershipKey(value)).toBe(key);
        expect(iriOwnershipKey(key)).toBe(key);
    });

    it('gives an IRI and its host-case look-alike one key and keeps both spellings distinct', () => {
        const published = 'https://sBPMN.github.io/2.0/';
        const lookAlike = 'https://sbpmn.github.io/2.0/';
        expect(published).not.toBe(lookAlike);
        expect(iriOwnershipKey(published)).toBe(iriOwnershipKey(lookAlike));
        expect(iriOwnershipKey('https://sbpmn.github.io/2.0/X')).not.toBe(iriOwnershipKey(lookAlike));
    });
});
