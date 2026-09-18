// Phase 13: optional Answer Hub picker. It only fills the existing composer;
// sending remains entirely on the established `send` command path.
export function mountQuickAnswer ({ api, getContext = () => ({}) }) {
  const composer = document.getElementById('reply')
  const message = document.getElementById('message')
  if (!composer || !message || document.getElementById('answer-hub-picker')) return
  const box = document.createElement('section'); box.id = 'answer-hub-picker'; box.className = 'quick-replies-popover'; box.hidden = true
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'composer-attach'; toggle.textContent = 'Answer Hub'; toggle.setAttribute('aria-expanded', 'false')
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search approved answers'
  const categories = document.createElement('div'); categories.className = 'quick-replies-cats'
  const list = document.createElement('div'); const state = document.createElement('p'); state.className = 'muted'
  const heading = document.createElement('div'); heading.className = 'quick-replies-head'; heading.append(Object.assign(document.createElement('strong'), { textContent: 'Answer Hub' }))
  const tools = document.createElement('div'); tools.className = 'quick-replies-tools'; tools.append(search)
  box.append(heading, tools, categories, state, list); composer.parentElement?.insertBefore(toggle, composer); composer.parentElement?.insertBefore(box, composer)
  const text = (tag, value) => { const el = document.createElement(tag); el.textContent = value; return el }
  let selectedCategory = ''
  const recentKey = 'answer-hub:recent'
  const favoriteKey = 'answer-hub:favorites'
  const loadIds = key => { try { return JSON.parse(localStorage.getItem(key) || '[]').filter(x => typeof x === 'string').slice(0, 12) } catch { return [] } }
  const saveIds = (key, values) => { try { localStorage.setItem(key, JSON.stringify([...new Set(values)].slice(0, 12))) } catch {} }
  const markRecent = id => saveIds(recentKey, [id, ...loadIds(recentKey)])
  const isFavorite = id => loadIds(favoriteKey).includes(id)
  const toggleFavorite = id => { const values = loadIds(favoriteKey); saveIds(favoriteKey, values.includes(id) ? values.filter(x => x !== id) : [id, ...values]); load() }
  const renderCategories = values => {
    categories.replaceChildren()
    const all = document.createElement('button'); all.type = 'button'; all.textContent = 'Suggested'; all.className = selectedCategory ? '' : 'active'
    all.addEventListener('click', () => { selectedCategory = ''; load() }); categories.append(all)
    for (const category of values) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = category.name; button.className = selectedCategory === category.id ? 'active' : ''
      button.addEventListener('click', () => { selectedCategory = category.id; load() }); categories.append(button)
    }
  }
  const load = async () => {
    list.replaceChildren(); state.textContent = 'Loading answers...'
    try {
      const result = await api('ah_quick_answer', { ...getContext(), category_id: selectedCategory || undefined, query: search.value.trim() })
      if (!result?.ok) throw new Error(result?.code || 'Answer Hub unavailable')
      let rows = result.data?.rows ?? []
      // Phase 14 supplies ranked matches; the picker keeps the safe Phase 13
      // list as a fallback so a recommender failure cannot affect composing.
      if (search.value.trim() && !selectedCategory) {
        const recommended = await api('ah_recommend', { ...getContext(), question: search.value.trim(), audience: 'human' })
        if (recommended?.ok && Array.isArray(recommended.data?.rows)) rows = recommended.data.rows
      }
      renderCategories(result.data?.categories ?? [])
      const recent = loadIds(recentKey); const favorites = loadIds(favoriteKey)
      const order = id => recent.includes(id) ? recent.indexOf(id) : 999
      const ordered = search.value.trim() || selectedCategory ? rows : [...rows].sort((a, b) => (favorites.includes(b.id) - favorites.includes(a.id)) || order(a.id) - order(b.id))
      state.textContent = ordered.length ? `${ordered.length} answers${favorites.length ? ' / favorites first' : ''}` : 'No matching answers'
      for (const answer of ordered) {
        const row = document.createElement('button'); row.type = 'button'; row.className = 'quick-answer-row'; row.setAttribute('aria-label', `Use ${answer.title}`)
        row.append(text('strong', answer.title), text('small', answer.body_template ?? ''))
        row.addEventListener('click', () => {
          // The sales person always gets an editable draft. Never send here.
          message.value = answer.body_template ?? ''; message.dataset.answerHubId = answer.id; markRecent(answer.id)
          message.dispatchEvent(new Event('input', { bubbles: true })); message.focus(); box.hidden = true; toggle.setAttribute('aria-expanded', 'false')
        })
        const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'subtle'; favorite.textContent = isFavorite(answer.id) ? 'Unfavorite' : 'Favorite'; favorite.addEventListener('click', () => toggleFavorite(answer.id))
        const report = document.createElement('button'); report.type = 'button'; report.className = 'subtle'; report.textContent = 'Report'; report.addEventListener('click', async () => { report.disabled = true; const result = await api('ah_feedback', { ...getContext(), answer_id: answer.id, kind: 'incorrect' }); report.textContent = result?.ok ? 'Reported' : 'Report failed' })
        const item = document.createElement('div'); item.append(row, favorite, report); list.append(item)
      }
    } catch {
      // A disabled/broken Hub must not interfere with the composer or Quick Replies.
      state.textContent = 'Answer Hub is unavailable; Quick Replies and manual reply remain available.'
    }
  }
  toggle.addEventListener('click', () => { box.hidden = !box.hidden; toggle.setAttribute('aria-expanded', String(!box.hidden)); if (!box.hidden) load() })
  search.addEventListener('input', () => { if (!box.hidden) load() })
}
