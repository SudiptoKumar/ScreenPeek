ALTER TABLE pages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO pages(slug,title,body_md) VALUES
('about','About','## Movie and TV information

Explore movie and TV details, cast, trailers, and legal ways to watch. This site provides information only. It does not host films, episodes, or downloads.

Catalogue information is imported into our own database. Browsing a page does not trigger a request to the source movie API. Streaming availability can vary by country and change over time; check the provider before making a purchase.

Provider availability data is credited to JustWatch wherever it appears.

For corrections and questions, visit [Contact](/contact/).'),
('privacy','Privacy','## Information sent to the site

Your browser sends ordinary request information to our hosting provider, Cloudflare. Search text is sent to our server to return matching catalogue entries.

When you submit a verdict, the server uses a day-specific hash derived from the request IP address and title to limit repeat votes. The vote marker expires within 24 hours. Our vote tables contain aggregate counts rather than individual voter records. Community totals are approximate.

## Information stored in your browser

- My List, recently viewed titles, and device vote markers use localStorage. They stay on this browser and are removed when you clear site data.
- The country preference cookie lasts up to 30 days.
- When popunder advertising is enabled, a cookie limits loading for the configured cap period, which defaults to 24 hours.

Blocking browser storage disables saving and voting. Browsing catalogue information still works.

## External services

Selecting a trailer loads an external YouTube player. Following a provider or other outbound link takes you to another service. Those services handle the resulting requests under their own policies.

When advertising is enabled, third-party providers may process device and request information and use their own storage. Their policies and available controls depend on the providers configured by the site owner.

## Questions

See [Contact](/contact/) for the current public contact details.'),
('dmca','DMCA & copyright requests','## Copyright concerns

This is an information website. It does not host films, episodes, or downloadable video files.

If you believe catalogue text or an image infringes your rights, use the public contact details on the [Contact page](/contact/). Please include:

- The exact URL and the material you are reporting.
- A description of the copyrighted work and your authority to act for its owner.
- Your name and a way to reply.
- A statement that the report is accurate and made in good faith, with your signature.

Public contact details are not available yet. Please check back.'),
('contact','Contact','## Get in touch

Public contact details are not available yet. Please check back.

For a catalogue correction or copyright concern, keep the exact page URL and a description of the issue so the site owner can identify the material.'),
('404','Page not found','We could not find this page. It may have moved, or its address may be incorrect. Explore the catalogue to find another movie or series.');
