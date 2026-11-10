import type { TitlePageData } from './detail.ts';
export function titleOriginality(data: TitlePageData) {
  const title = data.title;
  if (data.status !== 200 || !title) return { facts: '', questions: [], updated: null };
  const kind = title.type === 'tv' ? 'TV series' : 'movie';
  const genres = data.genres.map(row => row.name.toLowerCase()).join(', ');
  const directors = data.cast.filter(row => row.role === 'director').map(row => row.name);
  const stars = data.cast.filter(row => row.role === 'cast').slice(0, 3).map(row => row.name);
  const providers = [...new Set(data.providers.map(row => row.provider_name))];
  const release = title.release_date && /^\d{4}-\d{2}-\d{2}$/.test(title.release_date) && Number.isFinite(Date.parse(title.release_date)) ? new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(title.release_date)) : null;
  const facts = `${title.title} is ${title.year ? `a ${title.year}` : 'a'} ${genres ? `${genres} ` : ''}${kind}${directors.length ? ` directed by ${directors.join(', ')}` : ''}${title.runtime_min && title.runtime_min > 0 ? ` with a listed runtime of ${title.runtime_min} minutes` : ''}.`;
  return { facts, questions: [
    { question: `Where can I watch ${title.title}?`, answer: providers.length ? `Listed watch options in ${data.country} include ${providers.slice(0, 3).join(', ')}. Visit Where to Watch for current country-specific options; availability can change.` : `No watch provider is currently listed for ${data.country}. Visit Where to Watch to check another country.` },
    { question: `Who stars in ${title.title}?`, answer: stars.length ? `The listed cast includes ${stars.join(', ')}.` : 'Cast information is not available in the catalogue yet.' },
    { question: `When was ${title.title} released?`, answer: release ? `The catalogue lists ${release} as its release date.` : 'A release date has not been listed in the catalogue yet.' },
  ], updated: /^\d{4}-\d{2}-\d{2}/.test(title.updated_at) && Number.isFinite(Date.parse(title.updated_at)) ? title.updated_at.slice(0, 10) : null };
}
