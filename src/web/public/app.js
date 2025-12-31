document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('search-input');
    const searchButton = document.getElementById('search-button');
    const globalSearchCheckbox = document.getElementById('global-search');
    const topicsList = document.getElementById('topics-list');
    const noteBody = document.getElementById('note-body');
    const noteHeader = document.getElementById('note-header');
    const noteTitleInput = document.getElementById('note-title-input');
    const noteSubtopicInput = document.getElementById('note-subtopic-input');
    const noteStatusSelect = document.getElementById('note-status-select');
    const noteSaveButton = document.getElementById('note-save-button');
    const noteSaveStatus = document.getElementById('note-save-status');
    const noteMeta = document.getElementById('note-meta');

    let currentNote = null;

    // Debounce search
    let searchTimeout;
    searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const query = e.target.value;
            if (query.length > 0) {
                searchNotes(query);
            } else {
                loadTopics();
            }
        }, 300);
    });

    // Search on button click
    searchButton.addEventListener('click', () => {
        const query = searchInput.value;
        if (query.length > 0) {
            searchNotes(query);
        } else {
            loadTopics();
        }
    });

    // Search on Enter key
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const query = searchInput.value;
            if (query.length > 0) {
                searchNotes(query);
            } else {
                loadTopics();
            }
        }
    });

    async function loadTopics() {
        try {
            const response = await fetch('/api/topics');
            const data = await response.json();
            
            if (data.ok) {
                renderList(data.topics);
            }
        } catch (err) {
            console.error('Failed to load topics', err);
        }
    }

    async function searchNotes(query) {
        try {
            const isGlobal = globalSearchCheckbox.checked;
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&global=${isGlobal}`);
            const data = await response.json();
            
            if (data.ok) {
                renderList(data.notes.map(n => ({
                    topic: n.topic,
                    subtopic: n.subtopic,
                    workspace: n.workspace,
                    project: n.project,
                    isSearchResult: true
                })));
            }
        } catch (err) {
            console.error('Search failed', err);
        }
    }

    function renderList(items) {
        topicsList.innerHTML = '';
        
        if (items.length === 0) {
            topicsList.innerHTML = '<div style="padding: 15px; color: #666;">No results found</div>';
            return;
        }

        items.forEach(item => {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = 'topic-item';
            
            const title = document.createElement('div');
            title.className = 'topic-name';
            title.textContent = item.topic;
            
            el.appendChild(title);

            if (item.subtopic) {
                const subtitle = document.createElement('div');
                subtitle.className = 'subtopic-name';
                subtitle.textContent = item.subtopic;
                el.appendChild(subtitle);
            }

            el.addEventListener('click', () => loadNote(item.topic, item.subtopic, item.workspace, item.project));
            topicsList.appendChild(el);
        });
    }

    async function loadNote(topic, subtopic, workspace, project) {
        try {
            let url = `/api/note?topic=${encodeURIComponent(topic)}`;
            if (subtopic) {
                url += `&subtopic=${encodeURIComponent(subtopic)}`;
            }
            // When clicking a global search result, we MUST pass the note's workspace/project,
            // otherwise the backend will try to resolve it against the current repo context.
            if (workspace) {
                url += `&workspace=${encodeURIComponent(workspace)}`;
            }
            if (project) {
                url += `&project=${encodeURIComponent(project)}`;
            }
            
            const response = await fetch(url);
            const data = await response.json();

            if (data.ok && data.note) {
                renderNote(data.note);
            }
        } catch (err) {
            console.error('Failed to load note', err);
        }
    }

    function renderNote(note) {
        noteHeader.style.display = 'block';
        currentNote = note;
        noteTitleInput.value = note.topic || '';
        noteSubtopicInput.value = note.subtopic || '';
        noteStatusSelect.value = (note.review_status || 'DRAFT').toUpperCase();
        noteSaveStatus.textContent = '';
        
        let meta = [];
        if (note.workspace && note.project) meta.push(`${note.workspace}/${note.project}`);
        if (note.created_by) meta.push(`Author: ${note.created_by}`);
        
        noteMeta.textContent = meta.join(' • ');
        
        // Render markdown
        noteBody.innerHTML = marked.parse(note.body_md);
        
        // Highlight active item
        document.querySelectorAll('.topic-item').forEach(el => {
            el.classList.remove('active');
            if (el.querySelector('.topic-name').textContent === note.topic &&
                ((!note.subtopic && !el.querySelector('.subtopic-name')) ||
                 (note.subtopic && el.querySelector('.subtopic-name')?.textContent === note.subtopic))) {
                el.classList.add('active');
            }
        });
    }

    async function saveNoteMeta() {
        if (!currentNote) return;
        const nextTopic = noteTitleInput.value.trim();
        const nextSubtopic = noteSubtopicInput.value.trim();
        const nextStatus = noteStatusSelect.value;

        if (!nextTopic) {
            noteSaveStatus.textContent = 'Title is required';
            return;
        }

        noteSaveButton.disabled = true;
        noteSaveStatus.textContent = 'Saving...';

        try {
            const response = await fetch('/api/note', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    note_id: currentNote.note_id,
                    topic: nextTopic,
                    subtopic: nextSubtopic ? nextSubtopic : null,
                    review_status: nextStatus,
                    workspace: currentNote.workspace,
                    project: currentNote.project
                })
            });

            const data = await response.json().catch(() => null);
            if (!response.ok || !data || !data.ok) {
                const msg = (data && data.error) ? data.error : `Save failed (HTTP ${response.status})`;
                noteSaveStatus.textContent = msg;
                return;
            }

            noteSaveStatus.textContent = 'Saved';

            // Refresh list to reflect rename, then reload note by the new key
            const currentQuery = searchInput.value.trim();
            if (currentQuery.length > 0) {
                searchNotes(currentQuery);
            } else {
                loadTopics();
            }

            loadNote(nextTopic, nextSubtopic ? nextSubtopic : null, currentNote.workspace, currentNote.project);
        } catch (err) {
            console.error('Save failed', err);
            noteSaveStatus.textContent = 'Save failed';
        } finally {
            noteSaveButton.disabled = false;
        }
    }

    noteSaveButton.addEventListener('click', saveNoteMeta);

    // Initial load
    loadTopics();
});

