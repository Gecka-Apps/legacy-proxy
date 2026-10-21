import { describe, expect, it } from "vitest";
import {
  splitResponses,
  extractHref,
  textOf,
  hasResourceType,
  pickHref,
  splitProp,
  currentUserPrivileges,
  canWriteContent,
} from "../../src/carddav/client.js";

const MULTISTATUS = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/addressbook/user@x.io/personal/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Personal</D:displayname>
        <C:addressbook-description>My contacts</C:addressbook-description>
        <CS:getctag>"abc-123"</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/addressbook/user@x.io/personal/card-1.vcf</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype/>
        <D:getetag>"etag-card-1"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

describe("CardDAV XML helpers", () => {
  it("splits multistatus into per-response chunks", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(chunks).toHaveLength(2);
  });

  it("extracts <href> values, decoded", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(extractHref(chunks[0]!)).toBe("/dav/addressbook/user@x.io/personal/");
    expect(extractHref(chunks[1]!)).toBe("/dav/addressbook/user@x.io/personal/card-1.vcf");
  });

  it("reads element text with textOf", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(textOf(chunks[0]!, "displayname")).toBe("Personal");
    expect(textOf(chunks[0]!, "addressbook-description")).toBe("My contacts");
    expect(textOf(chunks[0]!, "getctag")).toBe('"abc-123"');
    expect(textOf(chunks[1]!, "getetag")).toBe('"etag-card-1"');
  });

  it("detects an addressbook resourcetype", () => {
    const chunks = splitResponses(MULTISTATUS);
    expect(hasResourceType(chunks[0]!, "addressbook")).toBe(true);
    expect(hasResourceType(chunks[1]!, "addressbook")).toBe(false);
  });

  it("picks an href out of a wrapper element", () => {
    const xml = `<x:multistatus xmlns:x="DAV:"><x:response><x:propstat><x:prop>
      <x:current-user-principal><x:href>/principals/user@x.io/</x:href></x:current-user-principal>
    </x:prop></x:propstat></x:response></x:multistatus>`;
    expect(pickHref(xml, "current-user-principal")).toBe("/principals/user@x.io/");
  });

  it("splits property specs into namespace + local name", () => {
    // "DAV:resourcetype" used to be emitted as <D:DAV:resourcetype/>, which
    // Radicale rejects as malformed XML (issue #3).
    expect(splitProp("DAV:resourcetype")).toEqual(["DAV:", "resourcetype"]);
    expect(splitProp("resourcetype")).toEqual(["DAV:", "resourcetype"]);
    expect(splitProp("urn:ietf:params:xml:ns:carddav addressbook-home-set")).toEqual([
      "urn:ietf:params:xml:ns:carddav",
      "addressbook-home-set",
    ]);
    expect(splitProp("http://calendarserver.org/ns/ getctag")).toEqual(["http://calendarserver.org/ns/", "getctag"]);
  });

  it("decodes XML entities and CDATA in element text", () => {
    const xml = `<x:r xmlns:x="DAV:"><x:href>/a/b%20c</x:href><x:n>A &amp; B</x:n><x:m><![CDATA[raw <bytes>]]></x:m></x:r>`;
    expect(textOf(xml, "n")).toBe("A & B");
    expect(textOf(xml, "m")).toBe("raw <bytes>");
  });
});

describe("current-user-privilege-set", () => {
  // Sabre (Nextcloud) for the birthday calendar: readable, renamable, no
  // write-content.
  const READ_ONLY = `<d:response><d:href>/remote.php/dav/calendars/u/contact_birthdays/</d:href><d:propstat><d:prop>
    <d:current-user-privilege-set>
      <d:privilege><d:read/></d:privilege>
      <d:privilege><cal:read-free-busy/></d:privilege>
      <d:privilege><d:write-properties/></d:privilege>
    </d:current-user-privilege-set>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  // Radicale for a writable collection: no bind.
  const RADICALE = `<D:response><D:href>/u/calendar/</D:href><D:propstat><D:prop>
    <D:current-user-privilege-set><D:privilege><D:read /></D:privilege><D:privilege><D:all /></D:privilege>
    <D:privilege><D:write /></D:privilege><D:privilege><D:write-properties /></D:privilege>
    <D:privilege><D:write-content /></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const NOT_FOUND = `<D:response><D:href>/u/calendar/</D:href><D:propstat><D:prop>
    <D:current-user-privilege-set/>
  </D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`;

  it("lists the privileges by local name, whatever the prefix", () => {
    expect(currentUserPrivileges(READ_ONLY)).toEqual(["read", "read-free-busy", "write-properties"]);
    expect(currentUserPrivileges(RADICALE)).toEqual(["read", "all", "write", "write-properties", "write-content"]);
  });

  it("is null when the property is absent or answered 404", () => {
    expect(currentUserPrivileges(MULTISTATUS)).toBeNull();
    expect(currentUserPrivileges(NOT_FOUND)).toBeNull();
  });

  it("allows writing on write-content, write or all, and when nothing is known", () => {
    expect(canWriteContent(currentUserPrivileges(READ_ONLY))).toBe(false);
    expect(canWriteContent(currentUserPrivileges(RADICALE))).toBe(true);
    expect(canWriteContent(["read", "write-content"])).toBe(true);
    expect(canWriteContent(["read", "write"])).toBe(true);
    expect(canWriteContent(["all"])).toBe(true);
    expect(canWriteContent(null)).toBe(true);
  });
});
