import { describe, expect, it } from "vitest";
import { parseVCards, serializeVCard, fold, escapeValue, unmanagedLines } from "../../src/carddav/vcard.js";

describe("parseVCards", () => {
  it("parses a vCard 4.0 with name, email, phone, org, address", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:42",
      "FN:Sophie Müller",
      "N:Müller;Sophie;;;",
      "EMAIL;TYPE=work:sophie@eurotech.example",
      "TEL;TYPE=cell:+49 30 8844 2200",
      "ORG:EuroTech GmbH",
      "TITLE:Frontend Lead",
      "ADR;TYPE=work:;;Kurfürstendamm 42;Berlin;;10719;Germany",
      "NOTE:Always brings Kuchen.",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c).toBeDefined();
    expect(c!.uid).toBe("urn:uuid:42");
    expect(c!.name?.full).toBe("Sophie Müller");
    expect(c!.name?.components).toEqual(
      expect.arrayContaining([
        { kind: "surname", value: "Müller" },
        { kind: "given", value: "Sophie" },
      ]),
    );
    expect(Object.values(c!.emails ?? {})[0]).toMatchObject({
      address: "sophie@eurotech.example",
      contexts: { work: true },
    });
    expect(Object.values(c!.phones ?? {})[0]).toMatchObject({
      number: "+49 30 8844 2200",
      features: { mobile: true },
    });
    expect(Object.values(c!.organizations ?? {})[0]).toEqual({ name: "EuroTech GmbH" });
    expect(Object.values(c!.titles ?? {})[0]).toEqual({ name: "Frontend Lead", kind: "title" });
    const addr = Object.values(c!.addresses ?? {})[0];
    expect(addr?.locality).toBe("Berlin");
    expect(addr?.country).toBe("Germany");
    expect(addr?.contexts).toEqual({ work: true });
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("Always brings Kuchen.");
  });

  it("unfolds soft-wrapped lines per RFC 6350 §3.2", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:1",
      "FN:Long",
      "NOTE:line one",
      " continued",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("line onecontinued");
  });

  it("parses multiple vCards in one body", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:a",
      "FN:Alice",
      "END:VCARD",
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:b",
      "FN:Bob",
      "END:VCARD",
    ].join("\r\n");
    const cards = parseVCards(text);
    expect(cards.map((c) => c.uid)).toEqual(["a", "b"]);
    expect(cards.map((c) => c.name?.full)).toEqual(["Alice", "Bob"]);
  });

  it("synthesises a UID when the vCard omits one", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "FN:NoUID",
      "EMAIL:nouid@x.io",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.uid).toMatch(/^urn:vcard:/);
  });

  it("treats KIND:group as kind=group", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g1",
      "KIND:group",
      "FN:Family",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.kind).toBe("group");
  });

  it("decodes escaped commas, semicolons and newlines in values", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:e",
      "FN:Esc",
      "NOTE:line1\\nline2\\, more\\; here",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(Object.values(c!.notes ?? {})[0]?.note).toBe("line1\nline2, more; here");
  });

  it("reads MEMBER lines into members for group cards", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g",
      "KIND:group",
      "FN:Team",
      "MEMBER:urn:uuid:a",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:b",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.members).toEqual({ "urn:uuid:a": true, "urn:uuid:b": true });
  });
});

describe("serializeVCard", () => {
  it("emits a vCard 4.0 that parses back to the same JSContact", () => {
    const card = {
      uid: "urn:uuid:rt",
      kind: "individual" as const,
      name: {
        full: "Dr. Sophie Müller",
        components: [
          { kind: "prefix" as const, value: "Dr." },
          { kind: "given" as const, value: "Sophie" },
          { kind: "surname" as const, value: "Müller" },
        ],
      },
      nicknames: { n1: { name: "Soph" } },
      emails: { e1: { address: "sophie@eurotech.example", contexts: { work: true }, pref: 1 } },
      phones: { p1: { number: "+49 30 8844 2200", contexts: { private: true }, features: { mobile: true } } },
      organizations: { o1: { name: "EuroTech GmbH", units: [{ name: "R&D" }] } },
      titles: { t1: { name: "Frontend Lead", kind: "title" as const }, t2: { name: "Mentor", kind: "role" as const } },
      addresses: {
        a1: {
          contexts: { work: true },
          street: "Kurfürstendamm 42",
          locality: "Berlin",
          postcode: "10719",
          country: "Germany",
        },
      },
      notes: { n1: { note: "Always brings Kuchen; and coffee, too.\nSecond line." } },
      links: { l1: { uri: "https://example.test/sophie", kind: "generic" as const } },
      anniversaries: { b1: { kind: "birth" as const, date: { "@type": "PartialDate" as const, year: 1990, month: 4, day: 12 } } },
    };
    const text = serializeVCard(card, { rev: "20260820T000000Z" });
    expect(text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n")).toBe(true);
    expect(text.endsWith("END:VCARD\r\n")).toBe(true);
    expect(text).toContain("N:Müller;Sophie;;Dr.;");
    expect(text).toContain("EMAIL;PROP-ID=e1;TYPE=work;PREF=1:sophie@eurotech.example");
    expect(text).toContain("TEL;PROP-ID=p1;TYPE=home,cell:+49 30 8844 2200");
    expect(text).toContain("ORG;PROP-ID=o1:EuroTech GmbH;R&D");
    expect(text).toContain("ROLE;PROP-ID=t2:Mentor");
    expect(text).toContain("ADR;PROP-ID=a1;TYPE=work:;;Kurfürstendamm 42;Berlin;;10719;Germany");
    expect(text).toContain("NOTE;PROP-ID=n1:Always brings Kuchen\\; and coffee\\, too.\\nSecond line.");
    expect(text).toContain("BDAY;PROP-ID=b1:19900412");
    expect(text).toContain("REV:20260820T000000Z");

    const [back] = parseVCards(text);
    expect(back!.uid).toBe(card.uid);
    // Components come back in N-field order (surname first), not input order.
    expect(back!.name?.full).toBe(card.name.full);
    expect(back!.name?.components).toHaveLength(card.name.components.length);
    expect(back!.name?.components).toEqual(expect.arrayContaining(card.name.components));
    expect(back!.emails).toEqual(card.emails);
    expect(back!.phones).toEqual(card.phones);
    expect(back!.organizations).toEqual(card.organizations);
    expect(back!.titles).toEqual(card.titles);
    expect(Object.values(back!.addresses!)[0]).toMatchObject({
      street: "Kurfürstendamm 42",
      locality: "Berlin",
      postcode: "10719",
      country: "Germany",
      contexts: { work: true },
    });
    expect(back!.notes).toEqual(card.notes);
    expect(back!.links).toEqual(card.links);
    expect(back!.anniversaries).toEqual(card.anniversaries);
    expect(back!.nicknames).toEqual(card.nicknames);
  });

  it("derives FN from components, org, or email when no full name is given", () => {
    expect(serializeVCard({ uid: "1", name: { components: [{ kind: "given", value: "Ada" }, { kind: "surname", value: "Lovelace" }] } }))
      .toContain("FN:Ada Lovelace");
    expect(serializeVCard({ uid: "2", organizations: { o: { name: "ACME" } } })).toContain("FN:ACME");
    expect(serializeVCard({ uid: "3", emails: { e: { address: "x@y.z" } } })).toContain("FN:x@y.z");
  });

  it("serialises groups with KIND and MEMBER, and partial anniversary dates", () => {
    const text = serializeVCard({
      uid: "g",
      kind: "group",
      name: { full: "Team" },
      members: { "urn:uuid:a": true, "urn:uuid:b": false },
      anniversaries: {
        w: { kind: "wedding", date: { "@type": "PartialDate", month: 6, day: 21 } },
        d: { kind: "death", date: { "@type": "Timestamp", utc: "2020-01-02T03:04:05Z" } },
      },
    });
    expect(text).toContain("KIND:group");
    expect(text).toContain("MEMBER:urn:uuid:a");
    expect(text).not.toContain("urn:uuid:b");
    expect(text).toContain("ANNIVERSARY;PROP-ID=w:--0621");
    expect(text).toContain("DEATHDATE;PROP-ID=d:20200102T030405Z");
  });

  it("folds long lines at 75 octets without splitting multi-byte characters", () => {
    const long = "NOTE:" + "ü".repeat(60);
    const folded = fold(long);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(Buffer.byteLength(l, "utf8")).toBeLessThanOrEqual(75);
    expect(lines.slice(1).every((l) => l.startsWith(" "))).toBe(true);
    // Unfolding restores the original.
    expect(folded.replace(/\r\n /g, "")).toBe(long);
  });

  it("escapes backslash, comma, semicolon and newline", () => {
    expect(escapeValue("a\\b,c;d\ne")).toBe("a\\\\b\\,c\\;d\\ne");
  });

  it("lists only the properties the projection does not manage", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:1",
      "FN:X",
      "X-FOO:ba",
      " r",
      "item1.EMAIL:x@y",
      "item1.X-ABLabel:Perso",
      "item2.X-SOCIALPROFILE:https://mastodon.example/@x",
      "item2.X-ABLabel:Fedi",
      "END:VCARD",
    ].join("\r\n");
    // The label of a managed property comes back from the JSContact side; the
    // label of an unmanaged one stays with it.
    expect(unmanagedLines(text)).toEqual(["X-FOO:bar", "item2.X-SOCIALPROFILE:https://mastodon.example/@x", "item2.X-ABLabel:Fedi"]);
  });
});

describe("RFC 9555 mapping", () => {
  const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";

  it("round-trips every property the webmail form writes, keys included", () => {
    const card = {
      uid: "urn:uuid:full",
      kind: "individual" as const,
      language: "fr",
      created: "2026-01-02T03:04:05Z",
      name: {
        full: "Dr. Sophie Anne Müller Jr.",
        components: [
          { kind: "title" as const, value: "Dr." },
          { kind: "given" as const, value: "Sophie" },
          { kind: "given2" as const, value: "Anne" },
          { kind: "surname" as const, value: "Müller" },
          { kind: "generation" as const, value: "Jr." },
        ],
        sortAs: { surname: "Mueller", given: "Sophie" },
      },
      emails: { e0: { address: "sophie@eurotech.example", contexts: { work: true }, label: "Bureau", pref: 1 } },
      phones: { p0: { number: "+49 30 8844 2200", contexts: { private: true }, features: { cell: true }, label: "Perso" } },
      onlineServices: {
        os0: { service: "Mastodon", uri: "https://mastodon.example/@sophie", label: "Fedi" },
        os1: { service: "GitHub", user: "sophie" },
        os2: { uri: "xmpp:sophie@jabber.example", vCardName: "impp" },
      },
      preferredLanguages: { lang0: { language: "de", pref: 1 }, lang1: { language: "en", contexts: { work: true } } },
      organizations: { o0: { name: "EuroTech GmbH", units: [{ name: "R&D" }], sortAs: "EuroTech" } },
      titles: { t0: { name: "Frontend Lead", kind: "title" as const, organizationId: "o0" }, t1: { name: "Mentor", kind: "role" as const } },
      addresses: {
        a0: {
          components: [
            { kind: "name", value: "Kurfürstendamm 42" },
            { kind: "locality", value: "Berlin" },
            { kind: "postcode", value: "10719" },
            { kind: "country", value: "Germany" },
          ],
          contexts: { work: true },
          countryCode: "DE",
          coordinates: "geo:52.5,13.3",
          timeZone: "Europe/Berlin",
          label: "Siège",
        },
      },
      anniversaries: {
        an0: { kind: "birth" as const, date: { "@type": "PartialDate" as const, year: 1990, month: 4, day: 12 }, place: { full: "Berlin" } },
        an1: { kind: "wedding" as const, date: { "@type": "PartialDate" as const, month: 6, day: 21 } },
        an2: { kind: "other" as const, date: { "@type": "PartialDate" as const, year: 2015 } },
      },
      personalInfo: {
        pi0: { kind: "hobby" as const, value: "Kuchen", level: "high" as const },
        pi1: { kind: "other" as const, value: "Chess" },
        pi2: { kind: "expertise" as const, value: "ZFS", level: "high" as const },
      },
      keywords: { VIP: true, "Berlin, Mitte": true },
      notes: { n0: { note: "Always brings Kuchen.", created: "2026-02-03T04:05:06Z", author: { name: "Me" } } },
      speakToAs: { grammaticalGender: "feminine", pronouns: { pr0: { pronouns: "she/her" } } },
      calendarUri: "https://cal.example/sophie",
      schedulingUri: "mailto:sophie@eurotech.example",
      freeBusyUri: "https://cal.example/sophie/fb",
      media: { m0: { kind: "photo" as const, uri: JPEG, mediaType: "image/jpeg" } },
      cryptoKeys: { k0: { uri: "https://keys.example/sophie.asc", mediaType: "application/pgp-keys" } },
      directories: { d0: { uri: "ldap://ldap.example/o=EuroTech", kind: "directory" as const } },
      links: { l0: { uri: "https://example.test/sophie", kind: "generic" as const, label: "Site" }, l1: { uri: "https://example.test/contact", kind: "contact" as const } },
      relatedTo: { "urn:uuid:paul": { relation: { spouse: true } } },
    };
    const text = serializeVCard(card, { rev: "20260820T000000Z" });
    const flat = text.replace(/\r\n /g, "");

    expect(flat).toContain("LANGUAGE:fr");
    expect(flat).toContain("CREATED:20260102T030405Z");
    expect(flat).toContain("N;SORT-AS=Mueller,Sophie:Müller;Sophie;Anne;Dr.;Jr.");
    expect(flat).toMatch(/^g\d+\.EMAIL;PROP-ID=e0;TYPE=work;PREF=1:sophie@eurotech\.example$/m);
    expect(flat).toMatch(/^g\d+\.X-ABLabel:Bureau$/m);
    expect(flat).toContain("TEL;PROP-ID=p0;TYPE=home,cell:+49 30 8844 2200");
    expect(flat).toMatch(/^g\d+\.SOCIALPROFILE;PROP-ID=os0;SERVICE-TYPE=Mastodon:https:\/\/mastodon\.example\/@sophie$/m);
    expect(flat).toContain("SOCIALPROFILE;PROP-ID=os1;SERVICE-TYPE=GitHub;VALUE=text:sophie");
    expect(flat).toContain("IMPP;PROP-ID=os2:xmpp:sophie@jabber.example");
    expect(flat).toContain("LANG;PROP-ID=lang0;PREF=1:de");
    expect(flat).toContain("LANG;PROP-ID=lang1;TYPE=work:en");
    expect(flat).toMatch(/^(g\d+)\.ORG;PROP-ID=o0;SORT-AS=EuroTech:EuroTech GmbH;R&D\r\n(?:.*\r\n)*?\1\.TITLE;PROP-ID=t0:Frontend Lead$/m);
    expect(flat).toContain("ROLE;PROP-ID=t1:Mentor");
    expect(flat).toMatch(/^g\d+\.ADR;PROP-ID=a0;TYPE=work;CC=DE;GEO="geo:52\.5,13\.3";TZ=Europe\/Berlin:;;Kurfürstendamm 42;Berlin;;10719;Germany$/m);
    expect(flat).toContain("BDAY;PROP-ID=an0:19900412");
    expect(flat).toContain("BIRTHPLACE;PROP-ID=an0:Berlin");
    expect(flat).toContain("ANNIVERSARY;PROP-ID=an1:--0621");
    expect(flat).toContain('JSPROP;JSPTR=anniversaries/an2:{"kind":"other"\\,"date":{"@type":"PartialDate"\\,"year":2015}}');
    expect(flat).toContain("HOBBY;PROP-ID=pi0;LEVEL=high:Kuchen");
    expect(flat).toContain("EXPERTISE;PROP-ID=pi2;LEVEL=expert:ZFS");
    expect(flat).toContain('JSPROP;JSPTR=personalInfo/pi1:{"kind":"other"\\,"value":"Chess"}');
    expect(flat).toContain("CATEGORIES:VIP,Berlin\\, Mitte");
    expect(flat).toContain("NOTE;PROP-ID=n0;CREATED=20260203T040506Z;AUTHOR-NAME=Me:Always brings Kuchen.");
    expect(flat).toContain("GRAMGENDER:feminine");
    expect(flat).toContain("PRONOUNS;PROP-ID=pr0:she/her");
    expect(flat).toContain("CALURI:https://cal.example/sophie");
    expect(flat).toContain("CALADRURI:mailto:sophie@eurotech.example");
    expect(flat).toContain("FBURL:https://cal.example/sophie/fb");
    expect(flat).toContain("KEY;PROP-ID=k0;MEDIATYPE=application/pgp-keys:https://keys.example/sophie.asc");
    expect(flat).toContain("ORG-DIRECTORY;PROP-ID=d0:ldap://ldap.example/o=EuroTech");
    expect(flat).toContain("CONTACT-URI;PROP-ID=l1:https://example.test/contact");
    expect(flat).toContain("RELATED;TYPE=spouse:urn:uuid:paul");
    // A data: URI is not TEXT: no escaping of its comma, and no MEDIATYPE duplicate.
    expect(flat).toContain(`PHOTO;PROP-ID=m0:${JPEG}`);

    const [back] = parseVCards(text);
    expect(back!.language).toBe("fr");
    expect(back!.created).toBe("2026-01-02T03:04:05Z");
    expect(back!.updated).toBe("2026-08-20T00:00:00Z");
    expect(back!.name?.sortAs).toEqual({ surname: "Mueller", given: "Sophie" });
    expect(back!.emails).toEqual(card.emails);
    expect(back!.phones).toEqual({ p0: { number: "+49 30 8844 2200", contexts: { private: true }, features: { mobile: true }, label: "Perso" } });
    expect(back!.onlineServices).toEqual({
      os0: { service: "Mastodon", uri: "https://mastodon.example/@sophie", label: "Fedi" },
      os1: { service: "GitHub", user: "sophie" },
      os2: { uri: "xmpp:sophie@jabber.example", vCardName: "impp" },
    });
    expect(back!.preferredLanguages).toEqual(card.preferredLanguages);
    expect(back!.organizations).toEqual(card.organizations);
    expect(back!.titles).toEqual(card.titles);
    expect(back!.addresses!["a0"]).toMatchObject({
      components: card.addresses.a0.components,
      contexts: { work: true },
      countryCode: "DE",
      coordinates: "geo:52.5,13.3",
      timeZone: "Europe/Berlin",
      label: "Siège",
    });
    expect(back!.anniversaries).toEqual(card.anniversaries);
    expect(back!.personalInfo).toEqual(card.personalInfo);
    expect(back!.keywords).toEqual(card.keywords);
    expect(back!.notes).toEqual(card.notes);
    expect(back!.speakToAs).toEqual(card.speakToAs);
    expect(back!).toMatchObject({ calendarUri: card.calendarUri, schedulingUri: card.schedulingUri, freeBusyUri: card.freeBusyUri });
    expect(back!.calendars).toEqual({
      cal1: { uri: card.calendarUri, kind: "calendar" },
      cal2: { uri: card.freeBusyUri, kind: "freeBusy" },
    });
    expect(back!.media).toEqual(card.media);
    expect(back!.cryptoKeys).toEqual(card.cryptoKeys);
    expect(back!.directories).toEqual(card.directories);
    expect(back!.links).toEqual(card.links);
    expect(back!.relatedTo).toEqual(card.relatedTo);
  });

  it("reads a vCard 3.0 inline photo as a data URI and Apple-style labels", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:1",
      "FN:X",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQ",
      " SkZJRg==",
      "item1.EMAIL;type=INTERNET:x@y",
      "item1.X-ABLabel:Perso",
      "CATEGORIES:Friends,Work\\, hard",
      "BDAY;VALUE=date:1990-04-12",
      "END:VCARD",
    ].join("\r\n");
    const [c] = parseVCards(text);
    expect(c!.media).toEqual({ photo1: { kind: "photo", uri: JPEG, mediaType: "image/jpeg" } });
    expect(c!.emails).toEqual({ e1: { address: "x@y", label: "Perso" } });
    expect(c!.keywords).toEqual({ Friends: true, "Work, hard": true });
    expect(c!.anniversaries).toEqual({ b1: { kind: "birth", date: { "@type": "PartialDate", year: 1990, month: 4, day: 12 } } });
  });

  it("lets the webmail's flat calendar fields replace the entries they stand for", () => {
    const stored = ["BEGIN:VCARD", "VERSION:4.0", "UID:1", "FN:X", "CALURI:https://a.example", "FBURL:https://a.example/fb", "CALADRURI:mailto:a@x", "END:VCARD"].join("\r\n");
    const [c] = parseVCards(stored);
    expect(c).toMatchObject({ calendarUri: "https://a.example", freeBusyUri: "https://a.example/fb", schedulingUri: "mailto:a@x" });

    const unchanged = serializeVCard(c!, { preserveFrom: stored });
    expect(unchanged.match(/^CALURI:/gm)).toHaveLength(1);
    expect(unchanged.match(/^FBURL:/gm)).toHaveLength(1);
    expect(unchanged.match(/^CALADRURI:/gm)).toHaveLength(1);

    const edited = serializeVCard({ ...c!, calendarUri: "https://b.example", schedulingUri: "" }, { preserveFrom: stored });
    expect(edited).toContain("CALURI:https://b.example");
    expect(edited).not.toContain("https://a.example\r\n");
    expect(edited).toContain("FBURL:https://a.example/fb");
    expect(edited).not.toContain("CALADRURI");
  });

  it("accepts the webmail's date strings and keeps a stored photo out of the preserved lines", () => {
    expect(serializeVCard({ uid: "1", anniversaries: { a: { kind: "birth", date: "1990-04-12" } } })).toContain("BDAY;PROP-ID=a:19900412");
    expect(serializeVCard({ uid: "1", anniversaries: { a: { kind: "wedding", date: "--06-21" } } })).toContain("ANNIVERSARY;PROP-ID=a:--0621");

    const stored = ["BEGIN:VCARD", "VERSION:4.0", "UID:1", "FN:X", `PHOTO:${JPEG}`, "X-FOO:bar", "END:VCARD"].join("\r\n");
    const [c] = parseVCards(stored);
    const rewritten = serializeVCard({ ...c!, media: undefined }, { preserveFrom: stored });
    expect(rewritten).not.toContain("PHOTO");
    expect(rewritten).toContain("X-FOO:bar");
  });
});
