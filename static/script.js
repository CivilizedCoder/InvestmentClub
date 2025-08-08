// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart;
    let currentStockData = null;
    let transactions = []; // This now holds all transactions, not just current holdings
    let recentSearches = [];
    const MAX_RECENT_SEARCHES = 5;
    let actionToConfirm = null; // A function to execute when modal is confirmed
    let sectionCollapseStates = {}; // To store open/closed state of portfolio sections

    // The currentUser object is the single source of truth for user state.
    let currentUser = { loggedIn: false, username: 'Guest', role: 'guest' };

    // --- INITIALIZATION ---
    async function initialize() {
        initializeEventListeners();
        // Fetch user status first to determine permissions before loading data
        await fetchUserStatus(); 
        
        // Fetch data based on login status
        if (currentUser.loggedIn && currentUser.role !== 'guest') {
            await fetchTransactions(); // Members/Admins get the full portfolio
        } else {
            await fetchWatchlist(); // Guests get only the public watchlist
        }
        
        // Update UI based on permissions and then activate the default tab
        updateUIVisibility();
        activateTab('home');

        // Fetch public content
        await fetchPageContent('about');
        await fetchPageContent('internships');
        
        // Set an interval to auto-refresh prices every 10 seconds
        setInterval(autoRefreshPrices, 10000);
        // Set an interval to refresh presentation vote timers
        setInterval(renderPresentations, 60000);
    }

    // --- AUTHENTICATION & USER STATUS ---
    async function fetchUserStatus() {
        try {
            const response = await fetch('/api/status');
            const data = await response.json();
            if (data.loggedIn) {
                currentUser = {
                    loggedIn: true,
                    id: data.user.id,
                    username: data.user.username,
                    role: data.user.role
                };
            } else {
                currentUser = { loggedIn: false, username: 'Guest', role: 'guest' };
            }
        } catch (error) {
            console.error("Error fetching user status:", error);
            currentUser = { loggedIn: false, username: 'Guest', role: 'guest' };
        }
        // Update the auth section in the sidebar
        renderAuthSection();
    }

    function renderAuthSection() {
        const authSection = document.getElementById('auth-section');
        if (!authSection) return;

        if (currentUser.loggedIn) {
            authSection.innerHTML = `
                <div class="text-center mb-2">
                    <p class="font-semibold text-white">${currentUser.username}</p>
                    <p class="text-sm text-gray-400 capitalize">${currentUser.role}</p>
                </div>
                <a href="/logout" class="button-secondary w-full text-center">Logout</a>
            `;
        } else {
            authSection.innerHTML = `
                <a href="/login" class="button-primary w-full text-center">Login / Register</a>
            `;
        }
    }

    // --- AUTO-REFRESHER ---
    function autoRefreshPrices() {
        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;

        if (activeTab === 'home') {
            renderPortfolioSummary();
        } else if (activeTab === 'portfolio') {
            // This re-renders the dashboard but preserves the open/closed state of sections
            renderPortfolioDashboard();
        }
    }

    // --- EVENT LISTENERS ---
    function initializeEventListeners() {
        document.getElementById('fetchBtn')?.addEventListener('click', executeSearch);
        document.getElementById('tickerInput')?.addEventListener('keypress', e => e.key === 'Enter' && executeSearch);
        document.getElementById('presentationForm')?.addEventListener('submit', handlePresentationSubmit);

        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                activateTab(link.dataset.tab);
            });
        });

        document.getElementById('modalCancelBtn')?.addEventListener('click', () => hideConfirmationModal());
        document.getElementById('modalConfirmBtn')?.addEventListener('click', () => {
            if (typeof actionToConfirm === 'function') {
                actionToConfirm();
            }
        });

        document.querySelector('main').addEventListener('click', (e) => {
            const deleteButton = e.target.closest('.delete-transaction-btn');
            if (deleteButton) {
                e.stopPropagation();
                const transactionId = parseInt(deleteButton.dataset.id, 10);
                promptForConfirmation(
                    'Delete Transaction',
                    'Are you sure you want to delete this transaction? This action cannot be undone.',
                    () => confirmDeleteTransaction(transactionId)
                );
                return;
            }
            
            const cardDeleteBtn = e.target.closest('.card-delete-btn');
            if (cardDeleteBtn) {
                cardDeleteBtn.closest('.content-card, .content-text-box').remove();
                return;
            }
            
            const textSizeBtn = e.target.closest('.card-text-size-btn');
            if (textSizeBtn) {
                const element = textSizeBtn.closest('.content-card, .content-text-box');
                const textContainer = element.querySelector('.content-card-text') || element;
                const currentSize = window.getComputedStyle(textContainer).fontSize;
                const newSize = prompt("Enter new font size (e.g., '16px', '1.2rem'):", currentSize);
                if (newSize) {
                    textContainer.style.fontSize = newSize;
                }
                return;
            }

            const card = e.target.closest('.summary-card');
            if (card && card.dataset.symbol) {
                document.getElementById('tickerInput').value = card.dataset.symbol;
                executeSearch();
                return;
            }

            // Combined handler for all collapsible headers
            const collapsibleHeader = e.target.closest('.collapsible-header, .portfolio-section-header');
            if (collapsibleHeader) {
                const content = collapsibleHeader.nextElementSibling;
                const isOpen = collapsibleHeader.classList.toggle('open');
                if (content) content.classList.toggle('open');
            
                // If it's a portfolio section, also update the state tracker
                const portfolioSection = collapsibleHeader.closest('.portfolio-section');
                if (portfolioSection) {
                    const sectionName = portfolioSection.dataset.sectionName;
                    if (sectionName) {
                        sectionCollapseStates[sectionName] = isOpen;
                    }
                }
                return;
            }
            
            const transactionLink = e.target.closest('.transaction-link');
            if (transactionLink) {
                e.preventDefault();
                document.getElementById('tickerInput').value = transactionLink.dataset.symbol;
                executeSearch();
            }
        });

        document.getElementById('portfolioContent')?.addEventListener('click', (e) => {
            if (e.target.id === 'addSectionBtn') {
                const sectionName = prompt("Enter new section name:");
                if (sectionName && sectionName.trim()) {
                    renderPortfolioDashboard(sectionName.trim());
                }
            }
        });

        document.getElementById('adminContent')?.addEventListener('click', e => {
            const roleSelect = e.target.closest('.role-select');
            if (roleSelect) {
                const userId = roleSelect.dataset.userId;
                const newRole = roleSelect.value;
                updateUserRole(userId, newRole);
            }

            const deleteUserBtn = e.target.closest('.delete-user-btn');
            if (deleteUserBtn) {
                const userId = deleteUserBtn.dataset.userId;
                const username = deleteUserBtn.dataset.username;
                promptForConfirmation(
                    'Delete User',
                    `Are you sure you want to delete the user "${username}"? This action is permanent.`,
                    () => confirmDeleteUser(userId)
                );
            }

            const setPasswordBtn = e.target.closest('.set-password-btn');
            if (setPasswordBtn) {
                const userId = setPasswordBtn.dataset.userId;
                const username = setPasswordBtn.dataset.username;
                const newPassword = prompt(`Enter new password for ${username}:`);
                if (newPassword) {
                    setUserPassword(userId, newPassword);
                }
            }
        });
        
        const addCardButtons = document.querySelectorAll('#addAboutCardBtn, #addInternshipsCardBtn');
        addCardButtons.forEach(btn => {
            const pageName = btn.id.includes('About') ? 'about' : 'internships';
            const textBtn = document.createElement('button');
            textBtn.id = `add${pageName.charAt(0).toUpperCase() + pageName.slice(1)}TextBtn`;
            textBtn.className = 'button-secondary hidden ml-2';
            textBtn.textContent = 'Add Text';
            btn.insertAdjacentElement('afterend', textBtn);
            textBtn.addEventListener('click', () => addTextBox(pageName));
        });

        document.getElementById('editAboutBtn').addEventListener('click', () => toggleContentEditable('about'));
        document.getElementById('editInternshipsBtn').addEventListener('click', () => toggleContentEditable('internships'));
        document.getElementById('addAboutCardBtn').addEventListener('click', () => addContentCard('about'));
        document.getElementById('addInternshipsCardBtn').addEventListener('click', () => addContentCard('internships'));
    }

    // --- USER PERMISSIONS ---
    function updateUIVisibility() {
        const role = currentUser.role;
        const loggedIn = currentUser.loggedIn;

        const guestTabs = ['home', 'search', 'internships', 'about'];
        const memberTabs = ['home', 'search', 'portfolio', 'transactions', 'presentations', 'internships', 'about', 'account'];
        const adminTabs = [...memberTabs, 'admin'];

        let visibleTabs;
        if (!loggedIn) {
            visibleTabs = guestTabs;
        } else {
            switch (role) {
                case 'member': visibleTabs = memberTabs; break;
                case 'admin': visibleTabs = adminTabs; break;
                default: visibleTabs = [...guestTabs, 'account'];
            }
        }
        
        document.querySelectorAll('.nav-link').forEach(link => {
            if (visibleTabs.includes(link.dataset.tab)) {
                link.classList.remove('hidden');
            } else {
                link.classList.add('hidden');
            }
        });

        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;
        if (!visibleTabs.includes(activeTab)) {
            activateTab('home');
        }

        const isAdmin = role === 'admin';
        document.getElementById('editAboutBtn').classList.toggle('hidden', !isAdmin);
        document.getElementById('editInternshipsBtn').classList.toggle('hidden', !isAdmin);
        
        const addSectionBtn = document.getElementById('addSectionBtn');
        if(addSectionBtn) {
            addSectionBtn.style.display = isAdmin ? 'block' : 'none';
        }
    }

    // --- NAVIGATION & TAB CONTROL ---
    async function activateTab(tab) {
        document.querySelectorAll('.nav-link').forEach(lnk => lnk.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active-content'));

        document.querySelector(`.nav-link[data-tab="${tab}"]`)?.classList.add('active');
        const targetContent = document.getElementById(`${tab}Content`);
        if (targetContent) {
            targetContent.classList.add('active-content');
        }
        
        switch (tab) {
            case 'home': renderPortfolioSummary(); break;
            case 'search': renderSearchTab(currentStockData); break;
            case 'portfolio': renderPortfolioDashboard(); break;
            case 'transactions': renderTransactionHistory(); break;
            case 'presentations': renderPresentations(); break;
            case 'account': await renderAccountPage(); break;
            case 'admin': renderAdminPanel(); break;
            case 'internships':
                calculateAndSetGridHeight(document.getElementById('internshipsPageContent'));
                break;
            case 'about':
                calculateAndSetGridHeight(document.getElementById('aboutPageContent'));
                break;
        }
    }

    // --- STOCK SEARCH ---
    function executeSearch() {
        const ticker = document.getElementById('tickerInput').value.trim().toUpperCase();
        if (!ticker) return;

        if (!recentSearches.includes(ticker)) {
            recentSearches.unshift(ticker);
            if (recentSearches.length > MAX_RECENT_SEARCHES) recentSearches.pop();
        }

        activateTab('search');
        fetchStockData(ticker);
    }

    function fetchStockData(ticker) {
        renderSearchTab(null, null, true); 
        fetch(`/api/stock/${ticker}`)
            .then(response => response.ok ? response.json() : response.json().then(err => { throw new Error(err.error) }))
            .then(data => {
                currentStockData = data;
                renderSearchTab(data);
            })
            .catch(error => renderSearchTab(null, error.message));
    }
    
    // --- DATABASE & PORTFOLIO LOGIC ---
    async function fetchTransactions() {
        try {
            const response = await fetch('/api/portfolio');
            if (!response.ok) {
                if (response.status === 401) {
                    console.log("User not logged in. Cannot fetch transactions.");
                    transactions = [];
                    return;
                }
                throw new Error('Failed to fetch transactions');
            }
            transactions = await response.json();
        } catch (error) {
            console.error("Fetch transactions error:", error);
            transactions = [];
        }
    }

    async function fetchWatchlist() {
        try {
            const response = await fetch('/api/watchlist');
            if (!response.ok) throw new Error('Failed to fetch watchlist');
            transactions = await response.json();
        } catch (error) {
            console.error("Fetch watchlist error:", error);
            transactions = [];
        }
    }

    async function addTransaction() {
        if (!currentStockData) return;
        const isReal = document.getElementById('isRealCheckbox').checked;
        const transactionType = document.querySelector('input[name="transactionType"]:checked').value;
    
        const newTransaction = {
            symbol: currentStockData.info.symbol,
            longName: currentStockData.info.longName,
            isReal: isReal,
            sector: currentStockData.info.sector || 'Other',
            transactionType: transactionType
        };
    
        if (isReal) {
            if (currentUser.role !== 'admin') {
                alert("Only admins can add real transactions.");
                return;
            }
            
            newTransaction.date = document.getElementById('purchaseDate').value;
            newTransaction.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
            newTransaction.price = parseFloat(document.getElementById('purchasePrice').value);
    
            if (isNaN(newTransaction.quantity) || isNaN(newTransaction.price) || !newTransaction.date) {
                alert("Please fill in all transaction details: Quantity, Price per Share, and Date.");
                return;
            }
            
            newTransaction.dollarValue = newTransaction.quantity * newTransaction.price;
    
        } else { // Watchlist item
            newTransaction.quantity = 0;
            newTransaction.dollarValue = 0;
            newTransaction.price = currentStockData.market_data.currentPrice;
            newTransaction.date = new Date().toISOString().split('T')[0];
        }
    
        const response = await fetch('/api/transaction', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newTransaction)
        });
    
        if (response.ok) {
            const addedTransaction = await response.json();
            transactions.push(addedTransaction);
            alert(`${newTransaction.symbol} transaction has been added.`);
            const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;
            if (activeTab) activateTab(activeTab);
        } else {
            const err = await response.json();
            alert(`Failed to add transaction: ${err.error}`);
        }
    }

    async function confirmDeleteTransaction(transactionId) {
        if (transactionId === null) return;
        try {
            const response = await fetch(`/api/transaction/${transactionId}`, { method: 'DELETE' });
            if (response.ok) {
                transactions = transactions.filter(h => h.id !== transactionId);
                const currentTab = document.querySelector('.nav-link.active')?.dataset.tab;
                if (currentTab) activateTab(currentTab);
            } else {
                alert(`Failed to delete: ${(await response.json()).error}`);
            }
        } catch (error) {
            console.error("Error deleting transaction:", error);
        } finally {
            hideConfirmationModal();
        }
    }

    async function updateHoldingSection(symbol, newSection) {
        transactions.forEach(tx => {
            if (tx.symbol === symbol) {
                tx.customSection = newSection;
            }
        });

        await fetch('/api/portfolio/section', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: symbol, section: newSection })
        });
    }
    
    function aggregatePortfolio(allTransactions) {
        const portfolio = {};
        const sortedTransactions = [...allTransactions].sort((a, b) => new Date(a.date) - new Date(b.date));

        for (const tx of sortedTransactions) {
            if (!tx.isReal) continue;

            if (!portfolio[tx.symbol]) {
                if (tx.transactionType === 'sell') {
                    console.error(`Found a 'sell' transaction for ${tx.symbol} before any 'buy'. Skipping.`);
                    continue;
                }
                portfolio[tx.symbol] = {
                    symbol: tx.symbol, longName: tx.longName, sector: tx.sector,
                    customSection: tx.customSection, quantity: 0, totalCost: 0,
                };
            }

            const position = portfolio[tx.symbol];
            
            if (tx.transactionType === 'buy') {
                position.quantity += tx.quantity;
                position.totalCost += tx.dollarValue;
            } else {
                if (position.quantity > 0) {
                    const avgCostPerShare = position.totalCost / position.quantity;
                    const costOfGoodsSold = avgCostPerShare * tx.quantity;
                    
                    position.quantity -= tx.quantity;
                    position.totalCost -= costOfGoodsSold;
                }
            }
            position.customSection = tx.customSection;
        }

        return Object.values(portfolio).filter(p => p.quantity > 0.00001);
    }

    // --- SECTION STATE MANAGEMENT (to prevent collapsing on refresh) ---
    function saveSectionCollapseStates() {
        const sections = document.querySelectorAll('.portfolio-section');
        sections.forEach(section => {
            const sectionName = section.dataset.sectionName;
            const header = section.querySelector('.portfolio-section-header');
            if (sectionName && header) {
                sectionCollapseStates[sectionName] = header.classList.contains('open');
            }
        });
    }
    
    function applySectionCollapseStates() {
        Object.keys(sectionCollapseStates).forEach(sectionName => {
            const section = document.querySelector(`.portfolio-section[data-section-name="${sectionName}"]`);
            if (section) {
                const header = section.querySelector('.portfolio-section-header');
                const content = header?.nextElementSibling;
                // Apply the saved state only if it was 'open'
                if (sectionCollapseStates[sectionName] && header && content) {
                    header.classList.add('open');
                    content.classList.add('open');
                }
            }
        });
    }

    // --- CONTENT MANAGEMENT ---
    async function fetchPageContent(pageName) {
        try {
            const response = await fetch(`/api/page/${pageName}`);
            const data = await response.json();
            const contentDiv = document.getElementById(`${pageName}PageContent`);
            contentDiv.innerHTML = data.content;
    
            const images = contentDiv.querySelectorAll('img');
            if (images.length === 0) {
                calculateAndSetGridHeight(contentDiv);
            } else {
                const promises = Array.from(images).map(img => {
                    return new Promise((resolve) => {
                        img.onload = resolve;
                        img.onerror = resolve;
                        if (img.complete) resolve();
                    });
                });
                await Promise.all(promises);
                calculateAndSetGridHeight(contentDiv);
            }
        } catch (error) {
            console.error(`Error fetching ${pageName} content:`, error);
        }
    }

    async function toggleContentEditable(pageName) {
        const contentDiv = document.getElementById(`${pageName}PageContent`);
        const editBtn = document.getElementById(`edit${pageName.charAt(0).toUpperCase() + pageName.slice(1)}Btn`);
        const addCardBtn = document.getElementById(`add${pageName.charAt(0).toUpperCase() + pageName.slice(1)}CardBtn`);
        const addTextBtn = document.getElementById(`add${pageName.charAt(0).toUpperCase() + pageName.slice(1)}TextBtn`);
        const isEditable = contentDiv.classList.contains('is-editing');

        contentDiv.classList.toggle('is-editing');

        if (isEditable) {
            editBtn.textContent = 'Edit';
            editBtn.classList.remove('button-success');
            editBtn.classList.add('button-secondary');
            addCardBtn.classList.add('hidden');
            addTextBtn.classList.add('hidden');
            
            contentDiv.querySelectorAll('.content-card, .content-text-box').forEach(el => {
                const header = el.querySelector('.card-header');
                if (header) header.removeEventListener('mousedown', onStartDragCard);
                const textEl = el.querySelector('.content-card-text, .text-box-content');
                if (textEl) textEl.contentEditable = false;
            });

            let finalHtml = '';
            contentDiv.querySelectorAll('.content-card, .content-text-box').forEach(el => {
                finalHtml += el.outerHTML;
            });

            await fetch(`/api/page/${pageName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: finalHtml })
            });

        } else {
            editBtn.textContent = 'Save';
            editBtn.classList.remove('button-secondary');
            editBtn.classList.add('button-success');
            addCardBtn.classList.remove('hidden');
            addTextBtn.classList.remove('hidden');
            calculateAndSetGridHeight(contentDiv);

            contentDiv.querySelectorAll('.content-card, .content-text-box').forEach(el => {
                if (!el.querySelector('.card-header')) {
                    const header = document.createElement('div');
                    header.className = 'card-header';
                    const hasText = el.querySelector('.content-card-text, .text-box-content');
                    const textSizeBtnVisibility = hasText ? '' : 'hidden';
                    header.innerHTML = `
                        <button class="card-text-size-btn ${textSizeBtnVisibility}"><i class="fas fa-text-height"></i></button>
                        <button class="card-delete-btn"><i class="fas fa-times-circle"></i></button>
                    `;
                    el.prepend(header);
                }
                
                const header = el.querySelector('.card-header');
                if(header) header.addEventListener('mousedown', onStartDragCard);
                
                const textEl = el.querySelector('.content-card-text, .text-box-content');
                if (textEl) {
                    textEl.contentEditable = true;
                }
            });
        }
    }

    function addContentCard(pageName) {
        const imageUrl = prompt("Please enter the URL for the image:");
        if (!imageUrl) return;
    
        const textContent = prompt("Please enter the text content for the card (optional):");
    
        const card = document.createElement('div');
        card.className = 'content-card';
        card.style.cssText = 'top: 10px; left: 10px; width: 300px; height: 400px;';
        
        let textHtml = '';
        let textSizeBtnVisibility = 'hidden';

        if (textContent) {
            textHtml = `<div class="content-card-text" contenteditable="true"><p>${textContent}</p></div>`;
            textSizeBtnVisibility = '';
        } else {
            card.classList.add('no-text');
        }

        card.innerHTML = `
            <div class="card-header">
                <button class="card-text-size-btn ${textSizeBtnVisibility}"><i class="fas fa-text-height"></i></button>
                <button class="card-delete-btn"><i class="fas fa-times-circle"></i></button>
            </div>
            <div class="content-card-image-wrapper">
                <img src="${imageUrl}" alt="User uploaded content">
            </div>
            ${textHtml}`;
    
        const contentDiv = document.getElementById(`${pageName}PageContent`);
        contentDiv.appendChild(card);
        
        card.querySelector('.card-header').addEventListener('mousedown', onStartDragCard);
        calculateAndSetGridHeight(contentDiv);
    }
    
    function addTextBox(pageName) {
        const textContent = prompt("Please enter the text for the box:");
        if (textContent === null) return;

        const textBox = document.createElement('div');
        textBox.className = 'content-text-box';
        textBox.style.cssText = 'top: 10px; left: 10px; width: 300px; height: 150px;';
        textBox.innerHTML = `
            <div class="card-header">
                 <button class="card-text-size-btn"><i class="fas fa-text-height"></i></button>
                 <button class="card-delete-btn"><i class="fas fa-times-circle"></i></button>
            </div>
            <div class="text-box-content" contenteditable="true">
                <p>${textContent}</p>
            </div>`;

        const contentDiv = document.getElementById(`${pageName}PageContent`);
        contentDiv.appendChild(textBox);
        
        textBox.querySelector('.card-header').addEventListener('mousedown', onStartDragCard);
        calculateAndSetGridHeight(contentDiv);
    }
    
    function calculateAndSetGridHeight(gridElement) {
        if (!gridElement) return;
    
        let maxHeight = 0;
        const padding = 50;
        const children = gridElement.querySelectorAll('.content-card, .content-text-box');
    
        children.forEach(child => {
            const childBottom = child.offsetTop + child.offsetHeight;
            if (childBottom > maxHeight) {
                maxHeight = childBottom;
            }
        });
    
        const minGridHeight = 500; 
        gridElement.style.minHeight = `${Math.max(minGridHeight, maxHeight + padding)}px`;
    }

    function onStartDragCard(e) {
        e.preventDefault();
        const card = e.currentTarget.parentElement;
        const grid = card.parentElement;
        const initialX = e.clientX;
        const initialY = e.clientY;
        const initialTop = card.offsetTop;
        const initialLeft = card.offsetLeft;
        const gridSnap = 10;

        function onDrag(moveEvent) {
            const dx = moveEvent.clientX - initialX;
            const dy = moveEvent.clientY - initialY;
            
            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            newLeft = Math.round(newLeft / gridSnap) * gridSnap;
            newTop = Math.round(newTop / gridSnap) * gridSnap;

            card.style.left = `${newLeft}px`;
            card.style.top = `${newTop}px`;

            calculateAndSetGridHeight(grid);
        }

        function onStopDrag() {
            document.removeEventListener('mousemove', onDrag);
            document.removeEventListener('mouseup', onStopDrag);
            calculateAndSetGridHeight(grid);
        }

        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onStopDrag);
    }


    // --- RENDER FUNCTIONS ---
    function renderSearchTab(data = null, error = null, isLoading = false) {
        const searchContent = document.getElementById('searchContent');
        const formatCurrency = (val) => val != null ? `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
        const formatLargeNumber = (val) => val != null ? Number(val).toLocaleString() : 'N/A';
        const timeframeButtons = ['1D', '1W', '1M', '3M', '1Y', 'MAX'];
    
        let contentHtml = `
            <h2 class="text-3xl font-bold mb-4">Stock Search</h2>
            <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <div class="lg:col-span-3" id="stockDataViewWrapper">`;
    
        if (isLoading) {
            contentHtml += `<div class="card"><p class="text-center">Loading...</p></div>`;
        } else if (error) {
            contentHtml += `<div class="card"><p class="text-red-400 text-center">Error: ${error}</p></div>`;
        } else if (data) {
            const { info, market_data, valuation_ratios, analyst_info, news } = data;
            
            const statsContent = `
                <div class="info-grid">
                    ${createKpiItem('Market Cap', formatLargeNumber(market_data.marketCap))}
                    ${createKpiItem('Volume', formatLargeNumber(market_data.volume))}
                    ${createKpiItem('52-Wk High', formatCurrency(market_data.fiftyTwoWeekHigh))}
                    ${createKpiItem('52-Wk Low', formatCurrency(market_data.fiftyTwoWeekLow))}
                    ${createKpiItem('50-Day Avg', formatCurrency(market_data.fiftyDayAverage))}
                    ${createKpiItem('200-Day Avg', formatCurrency(market_data.twoHundredDayAverage))}
                </div>`;
            const ratiosContent = `
                <div class="info-grid">
                    ${createKpiItem('Trailing P/E', valuation_ratios.trailingPE?.toFixed(2) || 'N/A')}
                    ${createKpiItem('Forward P/E', valuation_ratios.forwardPE?.toFixed(2) || 'N/A')}
                    ${createKpiItem('Price/Book', valuation_ratios.priceToBook?.toFixed(2) || 'N/A')}
                    ${createKpiItem('Price/Sales', valuation_ratios.priceToSales?.toFixed(2) || 'N/A')}
                    ${createKpiItem('PEG Ratio', valuation_ratios.pegRatio?.toFixed(2) || 'N/A')}
                    ${createKpiItem('EV/EBITDA', valuation_ratios.enterpriseToEbitda?.toFixed(2) || 'N/A')}
                </div>`;

            contentHtml += `
                <div class="card mb-6">
                    <div class="flex justify-between items-center">
                        <div><h2 class="text-3xl font-bold">${info.longName || 'N/A'}</h2><p class="text-lg text-gray-400">${info.symbol}</p></div>
                        <div class="text-right"><p class="text-4xl font-bold">${formatCurrency(market_data.currentPrice)}</p></div>
                    </div>
                    <p class="mt-4 text-gray-400">${info.longBusinessSummary || 'No summary available.'}</p>
                </div>
                <div class="card mb-6">
                    <div class="flex justify-between items-center mb-4">
                         <h3 class="text-2xl font-bold">Performance</h3>
                         <div id="stockReturnStats" class="text-right"></div>
                    </div>
                    <div class="flex space-x-2 mb-4">
                        ${timeframeButtons.map(t => `<button class="timeframe-btn" data-chart="stock" data-range="${t}">${t}</button>`).join('')}
                    </div>
                    <div class="chart-container" style="height: 400px;"><canvas id="stockChart"></canvas></div>
                </div>
                ${currentUser.loggedIn ? getAddToPortfolioHtml(info.symbol) : ''}
                <div class="space-y-4 mt-6">
                    ${createCollapsibleSection('Key Statistics', statsContent)}
                    ${createCollapsibleSection('Valuation Ratios', ratiosContent)}
                    ${createCollapsibleSection('Analyst Ratings', createAnalystInfoHtml(analyst_info))}
                    ${createCollapsibleSection('News', createNewsList(news))}
                </div>
            `;
        } else {
            contentHtml += `<div class="card"><p class="text-gray-500 text-center">Search for a stock to see details.</p></div>`;
        }
    
        contentHtml += `</div><div class="lg:col-span-1"><div class="card">
            <h3 class="text-xl font-bold mb-4">Recent Searches</h3>
            <ul id="recentSearchesList" class="space-y-2">
                ${recentSearches.length > 0 ? recentSearches.map(t => `<li><a href="#" class="recent-search-link text-cyan-400 hover:underline" data-ticker="${t}">${t}</a></li>`).join('') : `<li class="text-gray-500">No recent searches.</li>`}
            </ul>
        </div></div></div>`;
    
        searchContent.innerHTML = contentHtml;
    
        if (data) {
            setupIndividualStockChart();
            
            document.querySelectorAll('.timeframe-btn[data-chart="stock"]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const range = btn.dataset.range;
                    document.querySelectorAll('.timeframe-btn[data-chart="stock"]').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    
                    if (range === '1D') {
                        fetchAndUpdateIntradayStockChart(data.info.symbol, '1d', '5m');
                    } else {
                        updateChartAndStats(stockChart, data.historical, range, 'stockReturnStats', 'Close');
                    }
                });
            });

            document.querySelector('.timeframe-btn[data-chart="stock"][data-range="1Y"]')?.classList.add('active');
            updateChartAndStats(stockChart, data.historical, '1Y', 'stockReturnStats', 'Close');

            if (currentUser.loggedIn) {
                const isRealCheckbox = document.getElementById('isRealCheckbox');
                const realPurchaseInputs = document.getElementById('realPurchaseInputs');
                const addToPortfolioBtn = document.getElementById('addToPortfolioBtn');
    
                isRealCheckbox.addEventListener('change', () => {
                    realPurchaseInputs.classList.toggle('hidden', !isRealCheckbox.checked);
                    addToPortfolioBtn.textContent = isRealCheckbox.checked ? 'Add Transaction' : 'Add to Watchlist';
                });
                
                addToPortfolioBtn.addEventListener('click', addTransaction);
            }
        }
    
        searchContent.querySelectorAll('.recent-search-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById('tickerInput').value = e.target.dataset.ticker;
                executeSearch();
            });
        });
    }
    
    function getAddToPortfolioHtml(symbol) {
        const today = new Date().toISOString().split('T')[0];
        return `
            <div class="card mt-6">
                <h3 class="text-xl font-bold mb-4">Add ${symbol} to Portfolio or Watchlist</h3>
                <div class="flex items-center mb-4">
                    <input id="isRealCheckbox" type="checkbox" class="h-4 w-4 rounded border-gray-600 text-cyan-600 focus:ring-cyan-500 bg-gray-700">
                    <label for="isRealCheckbox" class="ml-3 block text-sm font-medium text-gray-300">This is a real holding (a transaction)</label>
                </div>
                <div id="realPurchaseInputs" class="space-y-4 hidden">
                    <div class="flex items-center space-x-6">
                        <label class="block text-sm font-medium text-gray-400">Transaction Type</label>
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="transactionType" value="buy" class="form-radio" checked>
                            <span class="ml-2">Buy</span>
                        </label>
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="transactionType" value="sell" class="form-radio">
                            <span class="ml-2">Sell</span>
                        </label>
                    </div>
                    <div id="quantityInputs">
                        <div class="grid grid-cols-2 gap-4">
                            <input type="number" step="any" id="purchaseQuantity" placeholder="Quantity (e.g., 10.5)" class="form-input">
                            <input type="number" step="any" id="purchasePrice" placeholder="Price per Share" class="form-input">
                        </div>
                    </div>
                    <div>
                        <label for="purchaseDate" class="block text-sm font-medium text-gray-400 mb-1">Transaction Date</label>
                        <input type="date" id="purchaseDate" value="${today}" class="form-input">
                    </div>
                </div>
                <button id="addToPortfolioBtn" class="button-success w-full mt-4">Add to Watchlist</button>
            </div>
        `;
    }

    function createCollapsibleSection(title, content) {
        const titleId = title.toLowerCase().replace(/\s+/g, '-');
        return `
            <div class="card">
                <div class="collapsible-header">
                    <h3 class="text-xl font-bold">${title}</h3>
                    <i class="fas fa-chevron-right collapsible-icon"></i>
                </div>
                <div class="collapsible-content" id="collapsible-content-${titleId}">
                    ${content}
                </div>
            </div>
        `;
    }

    function createKpiItem(label, value) {
        return `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`;
    }

    function createAnalystInfoHtml(analyst_info) {
        if (!analyst_info) return '<p class="text-gray-500">Analyst data not available.</p>';
        const formatCurrency = (val) => val != null ? `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
        return `
            <div class="info-grid">
                ${createKpiItem('Recommendation', analyst_info.recommendationKey?.toUpperCase() || 'N/A')}
                ${createKpiItem('Target High', formatCurrency(analyst_info.targetHighPrice))}
                ${createKpiItem('Target Mean', formatCurrency(analyst_info.targetMeanPrice))}
                ${createKpiItem('Target Low', formatCurrency(analyst_info.targetLowPrice))}
                ${createKpiItem('# of Opinions', analyst_info.numberOfAnalystOpinions || 'N/A')}
            </div>
        `;
    }

    function createNewsList(news) {
        if (!news || news.length === 0) {
            return '<p class="text-gray-500">No recent news.</p>';
        }
        let html = '<ul class="space-y-4">';
        news.slice(0, 5).forEach(item => {
            const newsContent = item.content;
            if (newsContent && newsContent.title && newsContent.clickThroughUrl && newsContent.clickThroughUrl.url) {
                const title = newsContent.title;
                const link = newsContent.clickThroughUrl.url;
                const publisher = newsContent.provider?.displayName || 'No publisher listed';

                html += `
                    <li class="border-b border-gray-700 pb-2">
                        <a href="${link}" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-cyan-400">${title}</a>
                        <p class="text-sm text-gray-400">${publisher}</p>
                    </li>`;
            }
        });
        html += '</ul>';
        return html;
    }

    async function renderPortfolioSummary() {
        const summaryList = document.getElementById('portfolioSummaryList');
        const summaryTitle = document.querySelector('#portfolioSummary h3');
        if (!summaryList || !summaryTitle) return;
    
        summaryTitle.textContent = (currentUser.loggedIn && currentUser.role !== 'guest') ? 'Portfolio Snapshot' : 'Club Watchlist';
    
        const currentPositions = aggregatePortfolio(transactions);
        const positionSymbols = new Set(currentPositions.map(p => p.symbol));
        const watchlistItems = transactions.filter(t => !t.isReal && !positionSymbols.has(t.symbol));
    
        if (watchlistItems.length === 0 && currentPositions.length === 0) {
            summaryList.innerHTML = '<p class="col-span-full text-center text-gray-500 card">No items to display.</p>';
            return;
        }
    
        try {
            const tickers = [...new Set([...currentPositions.map(p => p.symbol), ...watchlistItems.map(t => t.symbol)])];
            const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
            if (!response.ok) throw new Error('Failed to fetch quotes');
            
            const quotes = await response.json();
            summaryList.innerHTML = '';
    
            const allItems = [...currentPositions, ...watchlistItems];
    
            allItems.forEach(item => {
                const quote = quotes[item.symbol];
                const isWatchlist = !item.hasOwnProperty('totalCost');
                const price = isWatchlist ? item.price : item.totalCost / item.quantity;
    
                const currentPrice = quote?.currentPrice ?? price;
                const priceChange = currentPrice - (quote?.previousClose ?? price);
                const priceChangePercent = (quote?.previousClose ?? 0) > 0 ? (priceChange / quote.previousClose) * 100 : 0;
                const changeColor = priceChange >= 0 ? 'text-green-400' : 'text-red-400';
                
                const card = document.createElement('div');
                card.className = `summary-card ${isWatchlist ? 'watchlist-card' : ''}`;
                card.dataset.symbol = item.symbol;
                card.innerHTML = `
                    ${isWatchlist && currentUser.role === 'admin' ? `<button class="delete-transaction-btn" data-id="${item.id}" title="Delete"><i class="fas fa-times-circle"></i></button>` : ''}
                    <div class="summary-card-content">
                        <div class="flex justify-between items-center">
                            <p class="font-bold text-lg">${item.symbol}</p>
                            <p class="font-semibold text-lg">${currentPrice != null ? '$' + currentPrice.toFixed(2) : 'N/A'}</p>
                        </div>
                        <p class="text-sm text-gray-400 truncate">${item.longName}</p>
                        <div class="text-right mt-2 ${changeColor}">
                            <span class="font-medium">${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}</span>
                            <span> (${priceChangePercent.toFixed(2)}%)</span>
                        </div>
                    </div>`;
                summaryList.appendChild(card);
            });
        } catch (error) {
            summaryList.innerHTML = `<p class="text-red-400 col-span-full text-center">Could not load prices. ${error.message}</p>`;
        }
    }

    function renderTransactionHistory() {
        const listEl = document.getElementById('transactionList');
        if (!listEl) return;

        if (!currentUser.loggedIn || currentUser.role === 'guest') {
            listEl.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-gray-500">Please log in as a Member or Admin to see transactions.</td></tr>';
            return;
        }

        const realTransactions = transactions.filter(item => item.isReal);

        listEl.innerHTML = '';
        if (realTransactions.length === 0) {
            listEl.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-gray-500">No real transactions.</td></tr>';
            return;
        }

        realTransactions.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-800 hover:bg-gray-800';
            const purchaseDetail = item.purchaseType === 'quantity' ? `${(item.quantity || 0).toFixed(4)} shares` : `$${(item.dollarValue || 0).toFixed(2)}`;
            const typeClass = item.transactionType === 'buy' ? 'text-green-400' : 'text-red-400';
            const typeText = item.transactionType.charAt(0).toUpperCase() + item.transactionType.slice(1);
            
            row.innerHTML = `
                <td class="p-3">${item.date || 'N/A'}</td>
                <td class="p-3 font-bold"><a href="#" class="transaction-link text-cyan-400 hover:underline" data-symbol="${item.symbol}">${item.symbol}</a></td>
                <td class="p-3">${item.longName}</td>
                <td class="p-3 font-bold ${typeClass}">${typeText}</td>
                <td class="p-3 text-right">${purchaseDetail}</td>
                <td class="p-3 text-right">$${(item.price || 0).toFixed(2)}</td>
                <td class="p-3 text-right font-semibold">$${(item.dollarValue || 0).toFixed(2)}</td>
                <td class="p-3 text-center"><button class="delete-transaction-btn" data-id="${item.id}"><i class="fas fa-times-circle"></i></button></td>
            `;
            listEl.appendChild(row);
        });
    }

    async function renderPresentations() {
        const listEl = document.getElementById('presentationList');
        const submitCard = document.getElementById('submitPresentationCard');
    
        if (currentUser.role === 'guest' || !currentUser.loggedIn) {
            submitCard.style.display = 'none';
        } else {
            submitCard.style.display = 'block';
        }
    
        if (!listEl) return;
        
        const isInitialLoad = listEl.innerHTML === '' || listEl.querySelector('.card');

        if (isInitialLoad) {
            listEl.innerHTML = '<p class="card">Loading presentations...</p>';
        }

        try {
            const response = await fetch(`/api/presentations`);
            const presentations = await response.json();
            listEl.innerHTML = '';
            if (presentations.length === 0) {
                listEl.innerHTML = '<p class="card text-gray-500">No presentations have been submitted yet.</p>';
                return;
            }
            presentations.forEach(p => {
                const card = document.createElement('div');
                card.className = 'card';
                const actionColor = p.action === 'Buy' ? 'text-green-400' : 'text-red-400';
                
                let voteInfoHtml = '';
                if (p.votesFor !== undefined && p.votesAgainst !== undefined) {
                    voteInfoHtml = `
                        <div class="flex items-center space-x-4">
                            <span class="flex items-center"><i class="fas fa-thumbs-up text-green-500 mr-2"></i> ${p.votesFor}</span>
                            <span class="flex items-center"><i class="fas fa-thumbs-down text-red-500 mr-2"></i> ${p.votesAgainst}</span>
                        </div>
                    `;
                }

                let voteButtons = '';
                const canVote = p.isVotingOpen && currentUser.loggedIn && currentUser.role !== 'guest';
                if (canVote && !p.hasVoted) {
                    voteButtons = `
                        <button class="vote-btn" data-id="${p.id}" data-type="for"><i class="fas fa-thumbs-up text-green-500"></i></button>
                        <button class="vote-btn" data-id="${p.id}" data-type="against"><i class="fas fa-thumbs-down text-red-500"></i></button>
                    `;
                } else if (canVote && p.hasVoted) {
                    const forVoted = p.voteDirection === 'for' ? 'voted' : '';
                    const againstVoted = p.voteDirection === 'against' ? 'voted' : '';
                    voteButtons = `
                        <button class="vote-btn ${forVoted}" disabled><i class="fas fa-thumbs-up text-green-500"></i></button>
                        <button class="vote-btn ${againstVoted}" disabled><i class="fas fa-thumbs-down text-red-500"></i></button>
                    `;
                }


                const timeRemaining = formatTimeRemaining(p.votingEndsAt);
                const timeStatusColor = p.isVotingOpen ? 'text-yellow-400' : 'text-gray-400';

                card.innerHTML = `
                    <h4 class="text-xl font-bold">${p.title}</h4>
                    <p class="text-sm text-gray-400 mb-2">Proposing to <span class="font-bold ${actionColor}">${p.action} ${p.ticker}</span></p>
                    <a href="${p.url}" target="_blank" rel="noopener noreferrer" class="text-cyan-400 hover:underline mb-3 block">View Presentation</a>
                    <div class="border-t border-gray-700 pt-3 mt-3 flex justify-between items-center">
                        <div>
                            ${voteInfoHtml}
                            <p class="text-sm ${timeStatusColor} mt-1">${timeRemaining}</p>
                        </div>
                        <div class="flex items-center space-x-4">
                            ${voteButtons}
                        </div>
                    </div>
                `;
                listEl.appendChild(card);
            });
            listEl.querySelectorAll('.vote-btn:not([disabled])').forEach(btn => btn.addEventListener('click', handleVote));
        } catch (error) {
            listEl.innerHTML = '<p class="card text-red-400">Could not load presentations.</p>';
        }
    }

    async function renderPortfolioDashboard(newSectionName = null) {
        saveSectionCollapseStates();
        const sectionsEl = document.getElementById('portfolioSections');
        const kpiCardEl = document.getElementById('portfolioKpiCard');
        if (!sectionsEl || !kpiCardEl) return;
    
        if (!currentUser.loggedIn || currentUser.role === 'guest') {
            sectionsEl.innerHTML = '<p class="card text-center text-gray-500">Please log in as a Member or Admin to see the portfolio dashboard.</p>';
            kpiCardEl.innerHTML = '';
            return;
        }
    
        const currentPositions = aggregatePortfolio(transactions);
        
        if (currentPositions.length === 0 && !newSectionName) {
            sectionsEl.innerHTML = '<p class="card text-center text-gray-500">No real holdings to analyze.</p>';
            kpiCardEl.innerHTML = '';
            return;
        }
        
        const quotes = await fetchQuotesForHoldings(currentPositions);
        const sections = groupHoldingsBySection(currentPositions, quotes);
        
        // --- Calculate and Render KPIs ---
        const totalPortfolioValue = Object.values(sections).reduce((sum, sec) => sum + sec.currentValue, 0);
        const totalInvestedCapital = Object.values(sections).reduce((sum, sec) => sum + sec.totalCost, 0);
        const totalGainLoss = totalPortfolioValue - totalInvestedCapital;
        const totalGainLossPercent = totalInvestedCapital > 0 ? (totalGainLoss / totalInvestedCapital) * 100 : 0;
        const gainLossColor = totalGainLoss >= 0 ? 'text-green-400' : 'text-red-400';

        kpiCardEl.innerHTML = `
            <div class="kpi-grid">
                <div>
                    <p class="kpi-label">Total Portfolio Value</p>
                    <p class="kpi-value">$${totalPortfolioValue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                </div>
                <div>
                    <p class="kpi-label">Invested Capital</p>
                    <p class="kpi-value">$${totalInvestedCapital.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
                </div>
                <div>
                    <p class="kpi-label">Total Gain / Loss</p>
                    <p class="kpi-value ${gainLossColor}">
                        ${totalGainLoss >= 0 ? '+' : '-'}$${Math.abs(totalGainLoss).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                        <span class="text-base font-medium">(${totalGainLossPercent.toFixed(2)}%)</span>
                    </p>
                </div>
            </div>
        `;
        
        // --- Render Sections ---
        if (newSectionName && !sections[newSectionName]) {
            sections[newSectionName] = { holdings: [], totalCost: 0, currentValue: 0 };
        }

        sectionsEl.innerHTML = '';
        Object.keys(sections).sort().forEach(sectionName => {
            const section = sections[sectionName];
            const sectionEl = createPortfolioSection(sectionName, section, totalPortfolioValue);
            sectionsEl.appendChild(sectionEl);
        });
        
        initializeDragAndDrop();
        applySectionCollapseStates();
    }

    async function fetchQuotesForHoldings(holdings) {
        if (holdings.length === 0) return {};
        const tickers = [...new Set(holdings.map(p => p.symbol))];
        const response = await fetch('/api/quotes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tickers })
        });
        return response.ok ? await response.json() : {};
    }

    function groupHoldingsBySection(positions, quotes) {
        const sections = {};
        positions.forEach(p => {
            const sectionName = p.customSection || p.sector || 'Uncategorized';
            if (!sections[sectionName]) {
                sections[sectionName] = { holdings: [], totalCost: 0, currentValue: 0 };
            }
            const quote = quotes[p.symbol];
            const currentValue = (p.quantity || 0) * (quote?.currentPrice ?? (p.totalCost / p.quantity));
            
            sections[sectionName].holdings.push({ ...p, currentValue });
            sections[sectionName].totalCost += p.totalCost || 0;
            sections[sectionName].currentValue += currentValue;
        });
        return sections;
    }

    function createPortfolioSection(name, section, totalPortfolioValue) {
        const sectionEl = document.createElement('div');
        sectionEl.className = 'portfolio-section card';
        sectionEl.dataset.sectionName = name;
        const earnings = section.currentValue - section.totalCost;
        const earningsPercent = section.totalCost > 0 ? (earnings / section.totalCost) * 100 : 0;
        const earningsColor = earnings >= 0 ? 'text-green-400' : 'text-red-400';
        const sectionWeight = totalPortfolioValue > 0 ? (section.currentValue / totalPortfolioValue) * 100 : 0;

        sectionEl.innerHTML = `
            <div class="portfolio-section-header flex justify-between items-center mb-4 cursor-pointer">
                <div>
                    <h3 class="text-2xl font-bold">${name}</h3>
                    <p class="text-sm text-gray-400">${sectionWeight.toFixed(2)}% of Portfolio</p>
                </div>
                <div class="text-right">
                    <p class="font-semibold text-xl ${earningsColor}">
                        ${earnings >= 0 ? '+' : '-'}$${Math.abs(earnings).toFixed(2)}
                        <span class="text-lg">(${earningsPercent.toFixed(2)}%)</span>
                    </p>
                    <p class="text-sm text-gray-400">Total Gain/Loss</p>
                </div>
                <i class="fas fa-chevron-right collapsible-icon"></i>
            </div>
            <div class="holding-list space-y-2">
                ${section.holdings.map(h => createHoldingCard(h, section.currentValue)).join('') || '<p class="text-gray-500 p-4 text-center">Drag holdings here.</p>'}
            </div>
        `;
        return sectionEl;
    }

    function createHoldingCard(h, sectionValue) {
        const gainLoss = h.currentValue - h.totalCost;
        const gainLossPercent = h.totalCost > 0 ? (gainLoss / h.totalCost) * 100 : 0;
        const gainLossColor = gainLoss >= 0 ? 'text-green-400' : 'text-red-400';
        const holdingWeight = sectionValue > 0 ? (h.currentValue / sectionValue) * 100 : 0;

        return `
            <div class="card bg-gray-800 p-3 flex justify-between items-center" data-symbol="${h.symbol}">
                <div>
                    <p class="font-bold text-lg">${h.symbol}</p>
                    <p class="text-sm text-gray-400">${(h.quantity || 0).toFixed(4)} shares</p>
                </div>
                <div class="text-center">
                    <p class="font-semibold">${holdingWeight.toFixed(2)}%</p>
                    <p class="text-xs text-gray-500">of Sector</p>
                </div>
                <div class="text-right">
                    <p class="font-semibold">$${h.currentValue.toFixed(2)}</p>
                    <p class="${gainLossColor}">
                        ${gainLoss >= 0 ? '+' : '-'}$${Math.abs(gainLoss).toFixed(2)}
                        <span class="text-sm">(${gainLossPercent.toFixed(2)}%)</span>
                    </p>
                </div>
            </div>
        `;
    }

    function initializeDragAndDrop() {
        if (currentUser.role !== 'admin') return;
        const holdingLists = document.querySelectorAll('.holding-list');
        holdingLists.forEach(list => {
            new Sortable(list, {
                group: 'portfolio',
                animation: 150,
                ghostClass: 'sortable-ghost',
                onEnd: function (evt) {
                    const symbol = evt.item.dataset.symbol;
                    const newSectionName = evt.to.closest('.portfolio-section').dataset.sectionName;
                    updateHoldingSection(symbol, newSectionName);
                },
            });
        });
    }

    // --- ADMIN PANEL ---
    async function renderAdminPanel() {
        const userListEl = document.getElementById('userManagementList');
        if (!userListEl) return;
        userListEl.innerHTML = '<tr><td colspan="4" class="text-center p-4">Loading users...</td></tr>';

        try {
            const response = await fetch('/api/users');
            if (!response.ok) throw new Error('Failed to fetch users.');
            const users = await response.json();

            userListEl.innerHTML = '';
            users.forEach(user => {
                const row = document.createElement('tr');
                row.className = 'border-b border-gray-800';
                const isCurrentUser = user.id === currentUser.id;
                const roleOptions = ['guest', 'member', 'admin']
                    .map(role => `<option value="${role}" ${user.role === role ? 'selected' : ''}>${role.charAt(0).toUpperCase() + role.slice(1)}</option>`)
                    .join('');

                row.innerHTML = `
                    <td class="p-3">${user.id}</td>
                    <td class="p-3 font-semibold">${user.username} ${isCurrentUser ? '(You)' : ''}</td>
                    <td class="p-3">
                        <select class="form-input role-select" data-user-id="${user.id}" ${isCurrentUser ? 'disabled' : ''}>
                            ${roleOptions}
                        </select>
                    </td>
                    <td class="p-3 text-center space-x-4">
                        <button class="set-password-btn" data-user-id="${user.id}" data-username="${user.username}" ${isCurrentUser ? 'disabled' : ''} title="Set Password">
                            <i class="fas fa-key text-yellow-500"></i>
                        </button>
                        <button class="delete-user-btn" data-user-id="${user.id}" data-username="${user.username}" ${isCurrentUser ? 'disabled' : ''} title="Delete User">
                            <i class="fas fa-trash-alt text-red-500"></i>
                        </button>
                    </td>
                `;
                userListEl.appendChild(row);
            });
        } catch (error) {
            userListEl.innerHTML = `<tr><td colspan="4" class="text-center p-4 text-red-400">${error.message}</td></tr>`;
        }
    }

    async function updateUserRole(userId, newRole) {
        try {
            const response = await fetch(`/api/users/${userId}/role`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: newRole })
            });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to update role.');
            }
            alert('User role updated successfully.');
            renderAdminPanel();
        } catch (error) {
            alert(`Error: ${error.message}`);
            renderAdminPanel();
        }
    }

    async function setUserPassword(userId, newPassword) {
        try {
            const response = await fetch(`/api/users/${userId}/set-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: newPassword })
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || 'Failed to set password.');
            }
            alert(result.message);
        } catch (error) {
            alert(`Error: ${error.message}`);
        }
    }

    async function confirmDeleteUser(userId) {
        try {
            const response = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to delete user.');
            }
            alert('User deleted successfully.');
            renderAdminPanel();
        } catch (error) {
            alert(`Error: ${error.message}`);
        } finally {
            hideConfirmationModal();
        }
    }

    // --- ACCOUNT PAGE ---
    async function renderAccountPage() {
        const accountContent = document.getElementById('accountContent');
        if (!accountContent) return;

        const response = await fetch('/account-partial');
        if (!response.ok) {
            accountContent.innerHTML = `<div class="card text-red-400"><p>Error: Could not load account details.</p></div>`;
            return;
        }
        accountContent.innerHTML = await response.text();

        document.getElementById('accountUsername').textContent = currentUser.username;
        document.getElementById('accountRole').textContent = currentUser.role;

        document.getElementById('changeUsernameForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const newUsername = document.getElementById('newUsername').value;
            if (!newUsername) return;

            const res = await fetch('/api/account/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: newUsername })
            });
            const result = await res.json();
            if (result.success) {
                alert(result.message);
                await fetchUserStatus();
                document.getElementById('accountUsername').textContent = currentUser.username;
                e.target.reset();
            } else {
                alert(`Error: ${result.error}`);
            }
        });

        document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const currentPassword = document.getElementById('currentPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            if (!currentPassword || !newPassword) return;

            const res = await fetch('/api/account/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
            });
            const result = await res.json();
            if (result.success) {
                alert(result.message);
                e.target.reset();
            } else {
                alert(`Error: ${result.error}`);
            }
        });
    }


    // --- UI HELPERS & MODAL ---
    function promptForConfirmation(title, message, onConfirm) {
        document.getElementById('modalTitle').textContent = title;
        document.getElementById('modalMessage').textContent = message;
        actionToConfirm = onConfirm;
        document.getElementById('confirmationModal')?.classList.remove('hidden');
    }
    
    function hideConfirmationModal() { 
        document.getElementById('confirmationModal')?.classList.add('hidden');
        actionToConfirm = null;
    }
    
    function formatTimeRemaining(endtime) {
        const t = getTimeRemaining(endtime);
        if (t.total <= 0) return "Voting has ended.";
        
        const parts = [];
        if (t.days > 0) parts.push(`${t.days}d`);
        if (t.hours > 0) parts.push(`${t.hours}h`);
        if (t.minutes > 0) parts.push(`${t.minutes}m`);
        
        if (parts.length === 0 && t.seconds > 0) return "Time left: <1m";
        return `Time left: ${parts.join(' ')}`;
    }

    function getTimeRemaining(endtime) {
        const total = Date.parse(endtime) - Date.parse(new Date());
        return {
            total,
            days: Math.floor(total / (1000 * 60 * 60 * 24)),
            hours: Math.floor((total / (1000 * 60 * 60)) % 24),
            minutes: Math.floor((total / 1000 / 60) % 60),
            seconds: Math.floor((total / 1000) % 60)
        };
    }
    
    // --- PRESENTATION HANDLERS ---
    async function handlePresentationSubmit(e) {
        e.preventDefault();
        const form = e.target;
        const presentation = {
            title: form.querySelector('#presentationTitle').value,
            url: form.querySelector('#presentationUrl').value,
            ticker: form.querySelector('#presentationTicker').value,
            action: form.querySelector('input[name="presentationAction"]:checked').value
        };
        const response = await fetch('/api/presentations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presentation) });
        if (response.ok) {
            form.reset();
            renderPresentations();
        } else {
            alert('Failed to submit presentation.');
        }
    }

    async function handleVote(e) {
        const button = e.currentTarget;
        const id = button.dataset.id;
        const voteType = button.dataset.type;
        const response = await fetch(`/api/presentations/${id}/vote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voteType }) });
        if (response.ok) {
            renderPresentations();
        } else {
            const err = await response.json();
            alert(`Failed to record vote: ${err.error}`);
        }
    }

    // --- CHARTING ---
    function setupIndividualStockChart() {
        const ctx = document.getElementById('stockChart')?.getContext('2d');
        if (!ctx) return;
        if (stockChart) stockChart.destroy();
        
        stockChart = new Chart(ctx, {
            type: 'line', data: { labels: [], datasets: [{ label: 'Price', data: [], borderColor: '#22D3EE', backgroundColor: 'rgba(34, 211, 238, 0.1)', fill: true, tension: 0.1, pointRadius: 0 }] },
            options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, scales: { x: { type: 'time', time: { unit: 'day' }, grid: { display: false } }, y: { grid: { color: 'rgba(255, 255, 255, 0.1)' } } }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1F2937', titleColor: '#E5E7EB', bodyColor: '#E5E7EB', borderColor: '#374151', borderWidth: 1, padding: 10, displayColors: false, callbacks: { title: (ctx) => new Date(ctx[0].parsed.x).toLocaleDateString(), label: (ctx) => `Price: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(ctx.parsed.y)}` } } } }
        });
    }

    async function fetchAndUpdateIntradayStockChart(ticker, period, interval) {
        try {
            const response = await fetch(`/api/stock/${ticker}/history?period=${period}&interval=${interval}`);
            if (!response.ok) throw new Error('Failed to fetch chart data');
            const data = await response.json();
            updateChartAndStats(stockChart, data, '1D', 'stockReturnStats', 'Close');
        } catch (error) {
            console.error(`Failed to fetch chart data for range ${period}:`, error);
        }
    }

    function updateChartAndStats(chart, fullData, range, statsContainerId, dataKey) {
        if (!chart || !fullData || fullData.length === 0) {
            const statsContainer = document.getElementById(statsContainerId);
            if(statsContainer) statsContainer.innerHTML = '';
            if (chart) {
                chart.data.labels = [];
                chart.data.datasets[0].data = [];
                chart.update();
            }
            return;
        };
    
        const now = new Date();
        let startDate = new Date();
        const dateKey = fullData[0] && fullData[0].Date ? 'Date' : 'Timestamp';
    
        switch (range) {
            case '1D': startDate.setDate(now.getDate() - 1); break;
            case '1W': startDate.setDate(now.getDate() - 7); break;
            case '1M': startDate.setMonth(now.getMonth() - 1); break;
            case '3M': startDate.setMonth(now.getMonth() - 3); break;
            case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
            case '5Y': startDate.setFullYear(now.getFullYear() - 5); break;
            case 'MAX': 
                if (fullData.length > 0) {
                    startDate = new Date(fullData[0][dateKey]); 
                }
                break;
        }
        
        const filteredData = fullData.filter(d => new Date(d[dateKey]) >= startDate);
    
        if (filteredData.length < 2) {
            const statsContainer = document.getElementById(statsContainerId);
            if(statsContainer) statsContainer.innerHTML = '<p class="return-period">Not enough data for period</p>';
            chart.data.labels = filteredData.map(d => d[dateKey]);
            chart.data.datasets[0].data = filteredData.map(d => d[dataKey]);
            chart.update();
            return;
        }
    
        const startValue = filteredData[0][dataKey];
        const endValue = filteredData[filteredData.length - 1][dataKey];
        const change = endValue - startValue;
        const percentChange = startValue !== 0 ? (change / startValue) * 100 : 0;
        const changeColor = change >= 0 ? 'positive' : 'negative';
        const sign = change >= 0 ? '+' : '';
    
        const statsContainer = document.getElementById(statsContainerId);
        if(statsContainer) {
            let changeDisplay;
            if (dataKey === 'ReturnIndex') {
                changeDisplay = `${sign}${percentChange.toFixed(2)}%`;
            } else {
                changeDisplay = `${sign}${change.toLocaleString('en-US', { style: 'currency', currency: 'USD' })} (${sign}${percentChange.toFixed(2)}%)`;
            }
            
            statsContainer.innerHTML = `
                <p class="return-value ${changeColor}">${changeDisplay}</p>
                <p class="return-period">For selected period</p>
            `;
        }
    
        chart.data.labels = filteredData.map(d => d[dateKey]);
        chart.data.datasets[0].data = filteredData.map(d => d[dataKey]);
        chart.options.scales.x.time.unit = (range === '1D') ? 'hour' : 'day';
        chart.update();
    }

    // --- START THE APP ---
    initialize();
});
