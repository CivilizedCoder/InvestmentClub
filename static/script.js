// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart;
    let currentStockData = null;
    let transactions = []; // This now holds all transactions, not just current holdings
    let recentSearches = [];
    const MAX_RECENT_SEARCHES = 5;
    let actionToConfirm = null; // A function to execute when modal is confirmed

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
        // Check which tab is currently active
        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;

        // If the user is on a page with live prices, refresh it
        if (activeTab === 'home') {
            renderPortfolioSummary();
        } else if (activeTab === 'portfolio') {
            renderPortfolioDashboard();
        }
    }

    // --- EVENT LISTENERS ---
    function initializeEventListeners() {
        document.getElementById('fetchBtn')?.addEventListener('click', executeSearch);
        document.getElementById('tickerInput')?.addEventListener('keypress', e => e.key === 'Enter' && executeSearch());
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
            
            // Listener for content card and text box delete buttons
            const cardDeleteBtn = e.target.closest('.card-delete-btn');
            if (cardDeleteBtn) {
                cardDeleteBtn.closest('.content-card, .content-text-box').remove();
                return;
            }
            
            // Listener for text size button
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

            const collapsibleHeader = e.target.closest('.collapsible-header, .portfolio-section-header');
            if (collapsibleHeader) {
                const content = collapsibleHeader.nextElementSibling;
                collapsibleHeader.classList.toggle('open');
                content.classList.toggle('open');
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

        // Event delegation for admin panel
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
        });
        
        // --- INJECT AND SET UP 'ADD TEXT' BUTTONS ---
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


        // Edit/Save Listeners for Static Pages
        document.getElementById('editAboutBtn').addEventListener('click', () => toggleContentEditable('about'));
        document.getElementById('editInternshipsBtn').addEventListener('click', () => toggleContentEditable('internships'));
        document.getElementById('addAboutCardBtn').addEventListener('click', () => addContentCard('about'));
        document.getElementById('addInternshipsCardBtn').addEventListener('click', () => addContentCard('internships'));
    }

    // --- USER PERMISSIONS ---
    function updateUIVisibility() {
        const role = currentUser.role;
        const guestTabs = ['home', 'search', 'internships', 'about'];
        const memberTabs = ['home', 'search', 'portfolio', 'transactions', 'presentations', 'internships', 'about', 'account'];
        const adminTabs = [...memberTabs, 'admin'];

        let visibleTabs;
        if (!currentUser.loggedIn) {
            visibleTabs = guestTabs;
        } else {
            switch (role) {
                case 'member': visibleTabs = memberTabs; break;
                case 'admin': visibleTabs = adminTabs; break;
                default: visibleTabs = guestTabs; // guest role
            }
        }
        
        // Show/hide nav links
        document.querySelectorAll('.nav-link').forEach(link => {
            if (visibleTabs.includes(link.dataset.tab)) {
                link.classList.remove('hidden');
            } else {
                link.classList.add('hidden');
            }
        });

        // If current tab is now hidden, switch to home
        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;
        if (!visibleTabs.includes(activeTab)) {
            activateTab('home');
        }

        // Show/hide admin buttons
        const isAdmin = role === 'admin';
        document.getElementById('editAboutBtn').classList.toggle('hidden', !isAdmin);
        document.getElementById('editInternshipsBtn').classList.toggle('hidden', !isAdmin);
        
        const addSectionBtn = document.getElementById('addSectionBtn');
        if(addSectionBtn) {
            addSectionBtn.style.display = isAdmin ? 'block' : 'none';
        }
    }


    // --- NAVIGATION & TAB CONTROL ---
    function activateTab(tab) {
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
            case 'account': renderAccountPage(); break;
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
            transactions = await response.json(); // Store watchlist in the same global array
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
            price: currentStockData.market_data.currentPrice,
            sector: currentStockData.info.sector || 'Other',
            transactionType: transactionType
        };

        if (isReal) {
            // Frontend check for better UX, but the backend now enforces this rule.
            if (currentUser.role !== 'admin') {
                alert("Only admins can add real transactions.");
                return;
            }
            const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
            newTransaction.purchaseType = purchaseType;
            newTransaction.date = document.getElementById('purchaseDate').value;

            if (purchaseType === 'quantity') {
                newTransaction.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
                newTransaction.price = parseFloat(document.getElementById('purchasePrice').value);
                if (isNaN(newTransaction.quantity) || isNaN(newTransaction.price) || !newTransaction.date) {
                    alert("Please fill in all transaction details."); return;
                }
                newTransaction.dollarValue = newTransaction.quantity * newTransaction.price;
            } else { // 'value'
                newTransaction.dollarValue = parseFloat(document.getElementById('purchaseValue').value);
                const purchasePrice = parseFloat(document.getElementById('purchasePriceByValue').value);

                if (isNaN(newTransaction.dollarValue) || isNaN(purchasePrice) || !newTransaction.date) {
                    alert("Please fill in all transaction details: Dollar Value, Price per Share, and Date.");
                    return;
                }
                newTransaction.price = purchasePrice;
                if (purchasePrice > 0) {
                    newTransaction.quantity = newTransaction.dollarValue / purchasePrice;
                } else {
                    newTransaction.quantity = 0;
                }
            }
        } else { // Watchlist item
            newTransaction.quantity = 0;
            newTransaction.dollarValue = 0;
            newTransaction.price = currentStockData.market_data.currentPrice;
            newTransaction.date = new Date().toISOString().split('T')[0];
        }

        const response = await fetch('/api/transaction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newTransaction) });
        
        if (response.ok) {
            const addedTransaction = await response.json();
            transactions.push(addedTransaction);
            alert(`${newTransaction.symbol} transaction has been added.`);
            // Re-render the current tab to show the new data
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
        // Optimistically update the local data
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
    
    // --- PORTFOLIO AGGREGATION ---
    function aggregatePortfolio(allTransactions) {
        const portfolio = {}; // Keyed by symbol

        // Create a copy and sort transactions by date to process them in order
        const sortedTransactions = [...allTransactions].sort((a, b) => new Date(a.date) - new Date(b.date));

        for (const tx of sortedTransactions) {
            if (!tx.isReal) continue; // Skip watchlist items

            // Initialize position if it's the first time we see this symbol
            if (!portfolio[tx.symbol]) {
                if (tx.transactionType === 'sell') {
                    console.error(`Found a 'sell' transaction for ${tx.symbol} before any 'buy'. Skipping.`);
                    continue;
                }
                portfolio[tx.symbol] = {
                    symbol: tx.symbol,
                    longName: tx.longName,
                    sector: tx.sector,
                    customSection: tx.customSection,
                    quantity: 0,
                    totalCost: 0,
                };
            }

            const position = portfolio[tx.symbol];
            
            if (tx.transactionType === 'buy') {
                position.quantity += tx.quantity;
                position.totalCost += tx.dollarValue;
            } else { // 'sell'
                // Prevent division by zero if selling shares that were never bought (should be caught by backend)
                if (position.quantity > 0) {
                    const avgCostPerShare = position.totalCost / position.quantity;
                    const costOfGoodsSold = avgCostPerShare * tx.quantity;
                    
                    position.quantity -= tx.quantity;
                    position.totalCost -= costOfGoodsSold;
                }
            }
            // Update the custom section to the latest one for this symbol
            position.customSection = tx.customSection;
        }

        // Convert map to array and filter out zero-quantity positions
        return Object.values(portfolio).filter(p => p.quantity > 0.00001);
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
                // If no images, calculate height immediately
                calculateAndSetGridHeight(contentDiv);
            } else {
                // If there are images, wait for them to load
                const promises = Array.from(images).map(img => {
                    return new Promise((resolve) => {
                        // Resolve on load or error to ensure we don't wait forever
                        img.onload = resolve;
                        img.onerror = resolve;
                        // Handle cached images that might not fire 'load'
                        if (img.complete) {
                            resolve();
                        }
                    });
                });
                await Promise.all(promises);
                // Now that images are loaded, calculate the correct height
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
            // --- SAVE CONTENT ---
            editBtn.textContent = 'Edit';
            editBtn.classList.remove('button-success');
            editBtn.classList.add('button-secondary');
            addCardBtn.classList.add('hidden');
            addTextBtn.classList.add('hidden');
            
            // Detach drag handlers and remove contenteditable attributes
            contentDiv.querySelectorAll('.content-card, .content-text-box').forEach(el => {
                const header = el.querySelector('.card-header');
                if (header) header.removeEventListener('mousedown', onStartDragCard);
                const textEl = el.querySelector('.content-card-text, .text-box-content');
                if (textEl) textEl.contentEditable = false;
            });

            // Serialize the content
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
            // --- ENABLE EDITING ---
            editBtn.textContent = 'Save';
            editBtn.classList.remove('button-secondary');
            editBtn.classList.add('button-success');
            addCardBtn.classList.remove('hidden');
            addTextBtn.classList.remove('hidden');
            calculateAndSetGridHeight(contentDiv); // Adjust height when entering edit mode

            // Attach drag handlers and set contenteditable
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
    
    // --- DYNAMIC CONTENT GRID & DRAGGING LOGIC ---
    function calculateAndSetGridHeight(gridElement) {
        if (!gridElement) return;
    
        let maxHeight = 0;
        const padding = 50; // Extra space at the bottom
        const children = gridElement.querySelectorAll('.content-card, .content-text-box');
    
        children.forEach(child => {
            const childBottom = child.offsetTop + child.offsetHeight;
            if (childBottom > maxHeight) {
                maxHeight = childBottom;
            }
        });
    
        // Set a minimum height even if empty, to make it a droppable area
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
                    <div class="flex space-x-2 mb-4">
                        ${['Today', '1W', '1M', '3M', '6M', '1Y', '5Y', 'MAX'].map(t => `<button class="timeframe-btn" data-range="${t}">${t}</button>`).join('')}
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
            setupIndividualStockChart(data.historical);
            
            // Add event listeners to the new timeframe buttons
            searchContent.querySelectorAll('.timeframe-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const range = btn.dataset.range;
                    searchContent.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    // If range is 'Today' or '1W', fetch new high-frequency data
                    if (range === 'Today' || range === '1W') {
                        fetchAndupdateChart(data.info.symbol, range);
                    } else {
                        // Otherwise, use the existing daily data for longer ranges
                        updateChartByRange(data.historical, range);
                    }
                });
            });

            // Set a default active button and load its chart view
            searchContent.querySelector('.timeframe-btn[data-range="1Y"]')?.classList.add('active');
            updateChartByRange(data.historical, '1Y');

            if (currentUser.loggedIn) {
                const isRealCheckbox = document.getElementById('isRealCheckbox');
                const realPurchaseInputs = document.getElementById('realPurchaseInputs');
                const addToPortfolioBtn = document.getElementById('addToPortfolioBtn');
                const valueInputs = document.getElementById('valueInputs');
                const quantityInputs = document.getElementById('quantityInputs');

                isRealCheckbox.addEventListener('change', () => {
                    realPurchaseInputs.classList.toggle('hidden', !isRealCheckbox.checked);
                    addToPortfolioBtn.textContent = isRealCheckbox.checked ? 'Add Transaction' : 'Add to Watchlist';
                });

                document.querySelectorAll('input[name="purchaseType"]').forEach(radio => {
                    radio.addEventListener('change', () => {
                        const isQuantity = radio.value === 'quantity';
                        quantityInputs.classList.toggle('hidden', !isQuantity);
                        valueInputs.classList.toggle('hidden', isQuantity);
                    });
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
                    <div class="flex items-center space-x-6">
                        <label class="block text-sm font-medium text-gray-400">Entry Method</label>
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="purchaseType" value="value" class="form-radio" checked>
                            <span class="ml-2">By Dollar Value</span>
                        </label>
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="purchaseType" value="quantity" class="form-radio">
                            <span class="ml-2">By Quantity</span>
                        </label>
                    </div>
                    <div id="valueInputs">
                         <div class="grid grid-cols-2 gap-4">
                            <input type="number" step="any" id="purchaseValue" placeholder="Total Dollar Value" class="form-input">
                            <input type="number" step="any" id="purchasePriceByValue" placeholder="Price per Share" class="form-input">
                        </div>
                    </div>
                    <div id="quantityInputs" class="hidden">
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

        // Adjust title based on user role
        if (currentUser.loggedIn && currentUser.role !== 'guest') {
            summaryTitle.textContent = 'Portfolio Snapshot';
        } else {
            summaryTitle.textContent = 'Club Watchlist';
        }

        const watchlistItems = transactions.filter(t => !t.isReal);
        const currentPositions = aggregatePortfolio(transactions);

        if (watchlistItems.length === 0 && currentPositions.length === 0) {
            summaryList.innerHTML = '<p class="col-span-full text-center text-gray-500 card">No items to display.</p>';
            return;
        }

        try {
            const tickers = [...new Set(transactions.map(t => t.symbol))];
            const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
            if (!response.ok) throw new Error('Failed to fetch quotes');
            
            const quotes = await response.json();
            summaryList.innerHTML = ''; // Clear previous content

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
        const sectionsEl = document.getElementById('portfolioSections');
        if (!sectionsEl) return;

        if (!currentUser.loggedIn || currentUser.role === 'guest') {
            sectionsEl.innerHTML = '<p class="card text-center text-gray-500">Please log in as a Member or Admin to see the portfolio dashboard.</p>';
            updatePortfolioTotals([]);
            return;
        }

        const currentPositions = aggregatePortfolio(transactions);

        if (currentPositions.length === 0 && !newSectionName) {
            sectionsEl.innerHTML = '<p class="card text-center text-gray-500">No real holdings to analyze.</p>';
            updatePortfolioTotals([]);
            return;
        }

        const quotes = await fetchQuotesForHoldings(currentPositions);
        const sections = groupHoldingsBySection(currentPositions, quotes);
        const totalPortfolioValue = Object.values(sections).reduce((sum, sec) => sum + sec.currentValue, 0);

        if (newSectionName && !sections[newSectionName]) {
            sections[newSectionName] = { holdings: [], totalCost: 0, currentValue: 0 };
        }

        sectionsEl.innerHTML = '';
        Object.keys(sections).sort().forEach(sectionName => {
            const section = sections[sectionName];
            const sectionEl = createPortfolioSection(sectionName, section, totalPortfolioValue);
            sectionsEl.appendChild(sectionEl);
        });

        updatePortfolioTotals(Object.values(sections));
        initializeDragAndDrop();
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
        sectionEl.className = 'portfolio-section card mb-6';
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
            </div>
            <div class="holding-list space-y-2">
                ${section.holdings.map(h => createHoldingCard(h, section.currentValue)).join('') || '<p class="text-gray-500">Drag holdings here.</p>'}
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

    function updatePortfolioTotals(sections) {
        let totalValue = 0, totalCost = 0;
        sections.forEach(s => {
            totalValue += s.currentValue;
            totalCost += s.totalCost;
        });
        const totalEarnings = totalValue - totalCost;
        const totalEarningsPercent = totalCost > 0 ? (totalEarnings / totalCost) * 100 : 0;
        const earningsColor = totalEarnings >= 0 ? 'text-green-400' : 'text-red-400';

        document.getElementById('portfolioTotalValue').textContent = `$${totalValue.toFixed(2)}`;
        document.getElementById('portfolioTotalCost').textContent = `$${totalCost.toFixed(2)}`;
        const earningsEl = document.getElementById('portfolioTotalEarnings');
        earningsEl.innerHTML = `
            ${totalEarnings >= 0 ? '+' : '-'}$${Math.abs(totalEarnings).toFixed(2)}
            <span class="text-lg font-semibold">(${totalEarningsPercent.toFixed(2)}%)</span>
        `;
        earningsEl.className = `text-3xl font-bold mt-2 ${earningsColor}`;
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
                    <td class="p-3 text-center">
                        <button class="delete-user-btn" data-user-id="${user.id}" data-username="${user.username}" ${isCurrentUser ? 'disabled' : ''}>
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
            renderAdminPanel(); // Re-render to revert optimistic UI change
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
    
    function getTimeRemaining(endtime) {
        const total = Date.parse(endtime) - Date.parse(new Date());
        const seconds = Math.floor((total / 1000) % 60);
        const minutes = Math.floor((total / 1000 / 60) % 60);
        const hours = Math.floor((total / (1000 * 60 * 60)) % 24);
        const days = Math.floor(total / (1000 * 60 * 60 * 24));
        
        return { total, days, hours, minutes, seconds };
    }
    
    function formatTimeRemaining(endtime) {
        const t = getTimeRemaining(endtime);
        if (t.total <= 0) {
            return "Voting has ended.";
        }
        
        let parts = [];
        if (t.days > 0) parts.push(`${t.days}d`);
        if (t.hours > 0) parts.push(`${t.hours}h`);
        if (t.minutes > 0) parts.push(`${t.minutes}m`);
        
        if (parts.length === 0 && t.seconds > 0) {
            return "Time left: <1m";
        }
        
        return `Time left: ${parts.join(' ')}`;
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
    async function fetchAndupdateChart(ticker, range) {
        if (!stockChart) return;

        let period, interval, unit;
        if (range === 'Today') {
            period = '1d';
            interval = '1m';
            unit = 'minute';
        } else { // '1W'
            period = '7d';
            interval = '1h';
            unit = 'hour';
        }

        try {
            const response = await fetch(`/api/stock/${ticker}/history?period=${period}&interval=${interval}`);
            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Failed to fetch chart data');
            }
            const data = await response.json();
            
            if (data.length === 0) {
                console.warn(`No historical data returned for ${ticker} with range ${range}`);
                stockChart.data.labels = [];
                stockChart.data.datasets[0].data = [];
                stockChart.update();
                return;
            }

            stockChart.data.labels = data.map(d => d.Timestamp);
            stockChart.data.datasets[0].data = data.map(d => d.Close);
            stockChart.options.scales.x.time.unit = unit;
            stockChart.update();

        } catch (error) {
            console.error(`Failed to fetch chart data for range ${range}:`, error);
        }
    }

    function setupIndividualStockChart(historicalData) {
        const ctx = document.getElementById('stockChart')?.getContext('2d');
        if (!ctx) return;
        if (stockChart) stockChart.destroy();
        
        stockChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Price',
                    data: [],
                    borderColor: '#22D3EE',
                    backgroundColor: 'rgba(34, 211, 238, 0.1)',
                    fill: true,
                    tension: 0.1,
                    pointRadius: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: { 
                    x: { type: 'time', time: { unit: 'day' }, grid: { display: false } },
                    y: { grid: { color: 'rgba(255, 255, 255, 0.1)' } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1F2937',
                        titleColor: '#E5E7EB',
                        bodyColor: '#E5E7EB',
                        borderColor: '#374151',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            title: function(context) {
                                const date = new Date(context[0].parsed.x);
                                const timeOptions = { year: 'numeric', month: 'long', day: 'numeric' };
                                if (stockChart.options.scales.x.time.unit !== 'day') {
                                    timeOptions.hour = '2-digit';
                                    timeOptions.minute = '2-digit';
                                }
                                return date.toLocaleDateString('en-US', timeOptions);
                            },
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }

    function updateChartByRange(historicalData, range) {
        if (!stockChart || !historicalData || historicalData.length === 0) return;

        const now = new Date();
        let startDate = new Date();
        
        switch (range) {
            case '1W': startDate.setDate(now.getDate() - 7); break;
            case '1M': startDate.setMonth(now.getMonth() - 1); break;
            case '3M': startDate.setMonth(now.getMonth() - 3); break;
            case '6M': startDate.setMonth(now.getMonth() - 6); break;
            case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
            case '5Y': startDate.setFullYear(now.getFullYear() - 5); break;
            case 'MAX': startDate = new Date(historicalData[0].Date); break;
        }

        const filteredData = historicalData.filter(d => new Date(d.Date) >= startDate);
        
        stockChart.data.labels = filteredData.map(d => d.Date);
        stockChart.data.datasets[0].data = filteredData.map(d => d.Close);
        stockChart.options.scales.x.time.unit = 'day'; // Reset unit to day for longer timeframes
        stockChart.update();
    }

    // --- START THE APP ---
    initialize();
});
