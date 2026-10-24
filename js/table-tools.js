(function () {
    const tableStates = new WeakMap();
    const instances = new Set();
    const customTriggerSelector = '.customer-filter-trigger, .catalog-filter-trigger, .product-filter-trigger';
    let openPopup = null;
    let nextId = 0;

    function parseDateTime(val) {
        if (!val) return null;
        const str = String(val).trim();
        // Định dạng ISO: YYYY-MM-DDTHH:mm hoặc YYYY-MM-DD
        const isoMatch = str.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (isoMatch) {
            return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]),
                Number(isoMatch[4] || 0), Number(isoMatch[5] || 0), Number(isoMatch[6] || 0)).getTime();
        }
        // Định dạng Việt Nam: DD/MM/YYYY, HH:mm:ss hoặc DD/MM/YYYY
        const viMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})(?:[\s,]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
        if (viMatch) {
            return new Date(Number(viMatch[3]), Number(viMatch[2]) - 1, Number(viMatch[1]),
                Number(viMatch[4] || 0), Number(viMatch[5] || 0), Number(viMatch[6] || 0)).getTime();
        }
        // Giờ trước ngày: HH:mm:ss DD/MM/YYYY
        const timeFirstMatch = str.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?[\s,]+(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
        if (timeFirstMatch) {
            return new Date(Number(timeFirstMatch[6]), Number(timeFirstMatch[5]) - 1, Number(timeFirstMatch[4]),
                Number(timeFirstMatch[1]), Number(timeFirstMatch[2]), Number(timeFirstMatch[3] || 0)).getTime();
        }
        const parsed = Date.parse(str);
        return isNaN(parsed) ? null : parsed;
    }

    function parseNumeric(val) {
        if (!val) return null;
        const cleaned = String(val).replace(/[^0-9.-]/g, '');
        if (!cleaned || cleaned === '-' || cleaned === '.') return null;
        const num = parseFloat(cleaned);
        return isNaN(num) ? null : num;
    }

    function normalize(value) {
        return String(value == null ? '' : value)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[đĐ]/g, 'd')
            .toLocaleLowerCase('vi');
    }

    function cellText(cell) {
        const select = cell.querySelector('select');
        if (select) return select.selectedOptions[0] ? select.selectedOptions[0].text : '';
        const input = cell.querySelector('input, textarea');
        if (input) return input.value;
        return cell.innerText || cell.textContent || '';
    }

    function dataRows(tbody) {
        return Array.from(tbody.rows).filter(row =>
            !row.classList.contains('table-tools-empty-row') &&
            !(row.cells.length === 1 && row.cells[0].colSpan > 1)
        );
    }

    function tableForTrigger(trigger) {
        return trigger.closest('table');
    }

    function filterMenuForTrigger(trigger) {
        const menuId = trigger.dataset.tableToolsMenuId;
        if (menuId) return document.getElementById(menuId);
        const dropdown = trigger.closest('.dropdown');
        return dropdown ? dropdown.querySelector('.dropdown-menu') : null;
    }

    function placePopup(menu, trigger) {
        const triggerRect = trigger.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const gutter = 8;
        const left = Math.max(gutter, Math.min(triggerRect.left, window.innerWidth - menuRect.width - gutter));
        const below = triggerRect.bottom + gutter;
        const top = below + menuRect.height <= window.innerHeight - gutter
            ? below
            : Math.max(gutter, triggerRect.top - menuRect.height - gutter);
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    function closePopup(returnFocus) {
        if (!openPopup) return;
        openPopup.menu.classList.remove('show');
        openPopup.trigger.setAttribute('aria-expanded', 'false');
        const trigger = openPopup.trigger;
        openPopup = null;
        if (returnFocus) trigger.focus();
    }

    function attachCustomPopup(trigger) {
        if (trigger.dataset.tableToolsMenuId) return;
        const menu = filterMenuForTrigger(trigger);
        if (!menu) return;
        const id = menu.id || `table-tools-menu-${++nextId}`;
        menu.id = id;
        menu.classList.add('table-tools-popup');
        trigger.dataset.tableToolsMenuId = id;
        trigger.removeAttribute('data-toggle');
        document.body.appendChild(menu);
        const table = tableForTrigger(trigger);
        const state = table && tableStates.get(table);
        if (state) {
            menu.dataset.tableToolsTable = state.id;
            const index = Array.from(trigger.closest('th').parentElement.cells).indexOf(trigger.closest('th'));
            addSortOptions(menu, state, index);
            updateCustomSelection(table);
            updateSortOptions(state);
        }
    }

    function attachCustomPopups(root) {
        if (root.matches && root.matches(customTriggerSelector)) attachCustomPopup(root);
        root.querySelectorAll(customTriggerSelector).forEach(attachCustomPopup);
    }

    function selectedMenuValues(menu) {
        return Array.from(menu.querySelectorAll('input, select, textarea'))
            .map(control => {
                if (control.type === 'checkbox' || control.type === 'radio') return control.checked ? control.value : '';
                if (control.tagName === 'SELECT') {
                    return control.value && control.selectedOptions[0] ? control.selectedOptions[0].text : '';
                }
                return control.value.trim();
            })
            .filter(Boolean);
    }

    function updateCustomSelection(table) {
        table.querySelectorAll(customTriggerSelector).forEach(trigger => {
            const menu = filterMenuForTrigger(trigger);
            const values = menu ? selectedMenuValues(menu) : [];
            const active = values.length > 0;
            let selection = trigger.parentElement.nextElementSibling;
            if (!selection || !selection.classList.contains('table-tools-selection')) {
                selection = document.createElement('span');
                selection.className = 'table-tools-selection';
                trigger.parentElement.insertAdjacentElement('afterend', selection);
            }
            const selectedText = values.join(' · ');
            if (selection.textContent !== selectedText) selection.textContent = selectedText;
            selection.classList.toggle('d-none', !active);
            trigger.classList.toggle('text-primary', active);
        });
    }

    function headerLabel(header) {
        const clone = header.cloneNode(true);
        clone.querySelectorAll('button, .dropdown-menu, .table-tools-selection, .table-tools-sort-trigger, .table-tools-filter-trigger').forEach(element => element.remove());
        return clone.textContent.trim();
    }

    function isActionColumn(label) {
        return !label || /^(thao tác|hành động|action|nhập kho)$/i.test(label);
    }

    function createFilterMenu(state, index, label) {
        const menu = document.createElement('div');
        menu.className = 'dropdown-menu p-3 table-tools-filter-menu';
        menu.id = `table-tools-menu-${++nextId}`;
        const sortOptions = state.mode === 'filters-only' ? '' : `
            <div class="table-tools-sort-options" role="group" aria-label="Sắp xếp ${label}">
                <button type="button" class="btn btn-sm btn-outline-secondary table-tools-sort-option" data-sort-direction="asc" aria-pressed="false">A-Z</button>
                <button type="button" class="btn btn-sm btn-outline-secondary table-tools-sort-option" data-sort-direction="desc" aria-pressed="false">Z-A</button>
            </div>`;
        menu.innerHTML = `
            <label for="${menu.id}-input">Lọc ${label}</label>
            <input id="${menu.id}-input" type="search" class="form-control form-control-sm table-tools-filter-input" placeholder="Nhập để lọc..." autocomplete="off">
            ${sortOptions}
            <button type="button" class="btn btn-sm btn-outline-secondary table-tools-clear-column mt-2">Xóa bộ lọc cột</button>
        `;
        menu.dataset.tableToolsId = state.id;
        menu.dataset.columnIndex = String(index);
        document.body.appendChild(menu);
        return menu;
    }

    function addSortOptions(menu, state, index) {
        if (menu.querySelector('.table-tools-sort-options')) return;
        const options = document.createElement('div');
        options.className = 'table-tools-sort-options';
        options.setAttribute('role', 'group');
        options.setAttribute('aria-label', 'Sắp xếp cột');
        options.innerHTML = `
            <button type="button" class="btn btn-sm btn-outline-secondary table-tools-sort-option" data-sort-direction="asc" aria-pressed="false">A-Z</button>
            <button type="button" class="btn btn-sm btn-outline-secondary table-tools-sort-option" data-sort-direction="desc" aria-pressed="false">Z-A</button>
        `;
        menu.appendChild(options);
        menu.dataset.tableToolsId = state.id;
        menu.dataset.columnIndex = String(index);
    }

    function configureHeaders(state) {
        const headerRow = state.table.tHead && state.table.tHead.rows[0];
        if (!headerRow) return;
        const signature = Array.from(headerRow.cells).map(headerLabel).join('\u0000');
        if (state.headerSignature && state.headerSignature !== signature) {
            state.filters.clear();
            state.sortIndex = null;
            state.sortDirection = 'asc';
            state.query = '';
            if (state.searchInput) state.searchInput.value = '';
        }
        state.headerSignature = signature;
        Array.from(headerRow.cells).forEach((header, index) => {
            const label = headerLabel(header);
            if (isActionColumn(label)) return;

            const hasExistingFilter = header.querySelector(customTriggerSelector);
            if (!hasExistingFilter && !header.querySelector('.table-tools-filter-trigger')) {
                const filter = document.createElement('button');
                filter.type = 'button';
                filter.className = 'btn btn-sm btn-link table-tools-filter-trigger';
                filter.dataset.tableToolsId = state.id;
                filter.dataset.columnIndex = String(index);
                filter.setAttribute('aria-haspopup', 'true');
                filter.setAttribute('aria-expanded', 'false');
                filter.setAttribute('aria-label', `Lọc ${label}`);
                filter.title = `Lọc ${label}`;
                filter.innerHTML = '<i class="fas fa-filter"></i>';
                const menu = createFilterMenu(state, index, label);
                filter.dataset.tableToolsMenuId = menu.id;
                menu.querySelector('.table-tools-filter-input').value = state.filters.get(index) || '';
                header.appendChild(filter);
                if (state.mode !== 'filters-only') {
                    const selection = document.createElement('span');
                    selection.className = 'table-tools-selection d-none';
                    header.appendChild(selection);
                }
            }
        });
        const currentMenuIds = new Set(Array.from(state.table.querySelectorAll(
            '.table-tools-filter-trigger, ' + customTriggerSelector
        )).map(trigger => trigger.dataset.tableToolsMenuId).filter(Boolean));
        document.querySelectorAll('.table-tools-filter-menu, .table-tools-popup').forEach(menu => {
            const belongsToTable = menu.dataset.tableToolsId === state.id || menu.dataset.tableToolsTable === state.id;
            if (belongsToTable && !currentMenuIds.has(menu.id)) {
                if (openPopup && openPopup.menu === menu) closePopup(false);
                menu.remove();
            }
        });
        updateCustomSelection(state.table);
    }

    function createToolbar(state) {
        const toolbar = document.createElement('div');
        toolbar.className = 'table-tools-toolbar';
        if (state.mode === 'all') {
            toolbar.innerHTML = `
                <div class="input-group input-group-sm table-tools-search">
                    <div class="input-group-prepend"><span class="input-group-text"><i class="fas fa-search"></i></span></div>
                    <input type="search" class="form-control table-tools-global-search" placeholder="${state.table.dataset.tableToolsPlaceholder || 'Tìm trong bảng...'}" aria-label="${state.table.dataset.tableToolsPlaceholder || 'Tìm trong bảng...'}">
                </div>
            `;
            state.searchInput = toolbar.querySelector('.table-tools-global-search');
            state.searchInput.addEventListener('input', () => {
                state.query = state.searchInput.value;
                updateTable(state);
            });
        }
        const actions = document.createElement('div');
        actions.className = 'd-flex align-items-center ml-sm-auto';
        actions.innerHTML = `
            <span class="small text-muted text-nowrap table-tools-count"></span>
            <button type="button" class="btn btn-sm btn-link table-tools-clear-all ml-2">Xóa bộ lọc</button>
        `;
        actions.querySelector('.table-tools-clear-all').addEventListener('click', () => {
            state.query = '';
            if (state.searchInput) state.searchInput.value = '';
            state.filters.clear();
            state.table.querySelectorAll('.table-tools-filter-input').forEach(input => { input.value = ''; });
            updateTable(state);
        });
        toolbar.appendChild(actions);
        const wrapper = state.table.closest('.table-responsive');
        if (wrapper) wrapper.insertAdjacentElement('beforebegin', toolbar);
        else state.table.insertAdjacentElement('beforebegin', toolbar);
        state.toolbar = toolbar;
    }

    function updateSortOptions(state) {
        const headerRow = state.table.tHead && state.table.tHead.rows[0];
        if (headerRow) {
            Array.from(headerRow.cells).forEach((header, index) => {
                if (!isActionColumn(headerLabel(header))) {
                    header.setAttribute('aria-sort', state.sortIndex === index
                        ? (state.sortDirection === 'desc' ? 'descending' : 'ascending')
                        : 'none');
                }
            });
        }
        document.querySelectorAll(`.table-tools-filter-menu[data-table-tools-id="${state.id}"], .table-tools-popup[data-table-tools-table="${state.id}"]`)
            .forEach(menu => {
                menu.querySelectorAll('.table-tools-sort-option').forEach(button => {
                    const active = Number(menu.dataset.columnIndex) === state.sortIndex &&
                        button.dataset.sortDirection === state.sortDirection;
                    button.classList.toggle('active', active);
                    button.setAttribute('aria-pressed', String(active));
                });
            });
    }

    function updateGenericSelections(state) {
        state.table.querySelectorAll('.table-tools-filter-trigger').forEach(trigger => {
            const value = state.filters.get(Number(trigger.dataset.columnIndex)) || '';
            const selection = trigger.parentElement.querySelector(':scope > .table-tools-selection');
            if (!selection) return;
            if (selection.textContent !== value) selection.textContent = value;
            selection.classList.toggle('d-none', !value);
            trigger.classList.toggle('text-primary', Boolean(value));
        });
    }

    function updateTable(state) {
        const tbody = state.table.tBodies[0];
        if (!tbody) return;
        const observer = state.observer;
        if (observer) observer.disconnect();
        const rows = dataRows(tbody);
        const query = normalize(state.query);
        const sortIndex = state.sortIndex;
        const searchableColumns = state.table.tHead && state.table.tHead.rows[0]
            ? Array.from(state.table.tHead.rows[0].cells)
                .map((header, index) => ({ header, index }))
                .filter(({ header }) => !isActionColumn(headerLabel(header)))
                .map(({ index }) => index)
            : [];
        if (sortIndex !== null && state.mode !== 'filters-only') {
            const direction = state.sortDirection === 'asc' ? 1 : -1;
            rows.sort((first, second) =>
                cellText(first.cells[sortIndex] || document.createElement('td'))
                    .localeCompare(cellText(second.cells[sortIndex] || document.createElement('td')), 'vi', { sensitivity: 'base', numeric: true }) * direction
            );
            rows.forEach(row => tbody.appendChild(row));
        }
        let visible = 0;
        rows.forEach(row => {
            const cells = Array.from(row.cells);
            const searchableText = (searchableColumns.length ? searchableColumns : cells.map((_, index) => index))
                .map(index => cellText(cells[index] || document.createElement('td')))
                .join(' ');
            const matchesQuery = !query || normalize(searchableText).includes(query);
            const matchesFilters = Array.from(state.filters.entries()).every(([index, value]) =>
                !value || normalize(cellText(cells[index] || document.createElement('td'))).includes(normalize(value))
            );
            const matches = matchesQuery && matchesFilters;
            row.style.display = matches ? '' : 'none';
            if (matches) visible++;
        });

        const emptyRow = tbody.querySelector('.table-tools-empty-row');
        if (rows.length > 0 && visible === 0) {
            const row = emptyRow || document.createElement('tr');
            row.className = 'table-tools-empty-row';
            row.innerHTML = `<td colspan="${state.table.tHead.rows[0].cells.length}" class="text-center text-muted">Không tìm thấy kết quả phù hợp.</td>`;
            tbody.appendChild(row);
        } else if (emptyRow) {
            emptyRow.remove();
        }

        if (state.toolbar) {
            state.toolbar.querySelector('.table-tools-count').textContent =
                `Hiển thị: ${visible.toLocaleString('vi-VN')} / ${rows.length.toLocaleString('vi-VN')}`;
            state.toolbar.querySelector('.table-tools-clear-all').disabled =
                !state.query.trim() && state.filters.size === 0;
        }
        if (state.countTarget) {
            const total = Number(state.table.dataset.totalRows);
            state.countTarget.textContent =
                `${visible.toLocaleString('vi-VN')} / ${(Number.isFinite(total) && total >= 0 ? total : rows.length).toLocaleString('vi-VN')}`;
        }
        updateSortOptions(state);
        updateGenericSelections(state);
        updateCustomSelection(state.table);
        if (observer) {
            if (state.table.tHead) observer.observe(state.table.tHead, { childList: true, subtree: true });
            observer.observe(tbody, { childList: true, subtree: true, characterData: true });
        }
    }

    function initTable(table) {
        if (tableStates.has(table)) return;
        const customSearchEl = table.dataset.tableToolsSearch ? document.querySelector(table.dataset.tableToolsSearch) : null;
        const state = {
            id: `table-tools-${++nextId}`,
            table,
            mode: table.dataset.tableTools || 'all',
            query: customSearchEl ? customSearchEl.value : '',
            filters: new Map(),
            sortIndex: null,
            sortDirection: 'asc',
            headerSignature: '',
            searchInput: customSearchEl,
            toolbar: null,
            countTarget: table.dataset.tableToolsCount ? document.getElementById(table.dataset.tableToolsCount) : null,
            observer: null
        };
        if (customSearchEl && !customSearchEl.dataset.tableToolsBound) {
            customSearchEl.dataset.tableToolsBound = 'true';
            customSearchEl.addEventListener('input', () => {
                const searchSelector = table.dataset.tableToolsSearch;
                document.querySelectorAll(`[data-table-tools-search="${searchSelector}"]`).forEach(tbl => {
                    const st = tableStates.get(tbl);
                    if (st) {
                        st.query = customSearchEl.value;
                        updateTable(st);
                    }
                });
            });
        }
        tableStates.set(table, state);
        instances.add(state);
        if (state.mode === 'all') createToolbar(state);
        configureHeaders(state);
        state.observer = new MutationObserver(() => {
            configureHeaders(state);
            updateTable(state);
        });
        if (table.tHead) state.observer.observe(table.tHead, { childList: true, subtree: true });
        if (table.tBodies[0]) state.observer.observe(table.tBodies[0], { childList: true, subtree: true, characterData: true });
        updateTable(state);
    }

    function initAll(root) {
        if (root.matches && root.matches('[data-table-tools]')) initTable(root);
        root.querySelectorAll('[data-table-tools]').forEach(initTable);
        attachCustomPopups(root);
    }

    function findState(id) {
        for (const state of instances) if (state.id === id) return state;
        return null;
    }

    function openFilter(trigger) {
        const menu = filterMenuForTrigger(trigger);
        if (!menu) return;
        if (openPopup && openPopup.trigger === trigger) {
            closePopup(false);
            return;
        }
        closePopup(false);
        openPopup = { trigger, menu };
        menu.classList.add('show');
        trigger.setAttribute('aria-expanded', 'true');
        placePopup(menu, trigger);
        const input = menu.querySelector('.table-tools-filter-input');
        if (input) input.focus();
    }

    document.addEventListener('click', event => {
        const trigger = event.target.closest('.table-tools-filter-trigger, ' + customTriggerSelector);
        if (trigger) {
            event.preventDefault();
            openFilter(trigger);
            return;
        }
        if (!openPopup || openPopup.menu.contains(event.target)) return;
        closePopup(false);
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && openPopup) closePopup(true);
    });

    document.addEventListener('input', event => {
        const input = event.target;
        if (input.matches('.table-tools-filter-input')) {
            const state = findState(input.closest('.table-tools-filter-menu').dataset.tableToolsId);
            if (!state) return;
            const column = Number(input.closest('.table-tools-filter-menu').dataset.columnIndex);
            if (input.value.trim()) state.filters.set(column, input.value.trim());
            else state.filters.delete(column);
            updateTable(state);
            return;
        }
        const menu = input.closest('.table-tools-popup');
        const state = menu && menu.dataset.tableToolsTable ? findState(menu.dataset.tableToolsTable) : null;
        if (state) updateCustomSelection(state.table);
    });

    document.addEventListener('change', event => {
        const control = event.target;
        const menu = control.closest('.table-tools-popup');
        if (menu && menu.dataset.tableToolsTable) {
            const state = findState(menu.dataset.tableToolsTable);
            if (state) updateCustomSelection(state.table);
        }
    });

    document.addEventListener('click', event => {
        const clearColumn = event.target.closest('.table-tools-clear-column');
        if (clearColumn) {
            const menu = clearColumn.closest('.table-tools-filter-menu');
            const input = menu.querySelector('.table-tools-filter-input');
            input.value = '';
            const state = findState(menu.dataset.tableToolsId);
            if (state) {
                state.filters.delete(Number(menu.dataset.columnIndex));
                updateTable(state);
            }
            return;
        }
        const sort = event.target.closest('.table-tools-sort-option');
        if (sort) {
            const menu = sort.closest('.dropdown-menu');
            const state = findState(menu.dataset.tableToolsId);
            if (!state) return;
            state.sortIndex = Number(menu.dataset.columnIndex);
            state.sortDirection = sort.dataset.sortDirection;
            updateTable(state);
        }
    });

    window.addEventListener('resize', () => {
        if (openPopup) placePopup(openPopup.menu, openPopup.trigger);
    });
    window.addEventListener('scroll', () => {
        if (openPopup) placePopup(openPopup.menu, openPopup.trigger);
    }, true);

    const observer = new MutationObserver(records => {
        records.forEach(record => record.addedNodes.forEach(node => {
            if (node.nodeType === Node.ELEMENT_NODE) initAll(node);
        }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    initAll(document);
})();
