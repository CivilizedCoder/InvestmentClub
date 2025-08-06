// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart;
    let currentStockData = null;
    let portfolio = [];
    let recentSearches = [];
    const MAX_RECENT_SEARCHES = 5;
    let holdingToDeleteId = null;
    let currentUserRole = 'guest'; // 'guest', 'member', or 'admin'

    // --- INITIALIZATION ---
    async function initialize() {
        initializeEventListeners();
        await fetchPortfolio();
        updateUIVisibility();
        activateTab('home');
        fetchPageContent('about');
        fetchPageContent('internships');
        
        // Set an interval to auto-refresh prices every 10 seconds
        setInterval(autoRefreshPrices, 10000);
    }

    // --- AUTO-REFRESHER ---
    function autoRefreshPrices() {
        // Check which tab is currently active
        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;

        // If the user is on a page with live prices, refresh it
        if (activeTab === 'home') {
            console.log('Auto-refreshing portfolio summary...');
            renderPortfolioSummary();
        } else if (activeTab === 'portfolio') {
            console.log('Auto-refreshing portfolio dashboard...');
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
        document.getElementById('modalConfirmBtn')?.addEventListener('click', () => confirmDelete());

        document.querySelector('main').addEventListener('click', (e) => {
            const deleteButton = e.target.closest('.delete-btn');
            if (deleteButton) {
                e.stopPropagation();
                promptForDelete(parseInt(deleteButton.dataset.id, 10));
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

        document.getElementById('userRoleSelector').addEventListener('click', (e) => {
            if (e.target.matches('.role-btn')) {
                const newRole = e.target.dataset.role;
                setCurrentUserRole(newRole);
            }
        });

        // Edit/Save Listeners for Static Pages
        document.getElementById('editAboutBtn').addEventListener('click', () => toggleContentEditable('about'));
        document.getElementById('editInternshipsBtn').addEventListener('click', () => toggleContentEditable('internships'));
        document.getElementById('addAboutCardBtn').addEventListener('click', () => addContentCard('about'));
        document.getElementById('addInternshipsCardBtn').addEventListener('click', () => addContentCard('internships'));
    }

    // --- USER PERMISSIONS ---
    function setCurrentUserRole(role) {
        currentUserRole = role;
        document.querySelectorAll('.role-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.role === role);
        });
        updateUIVisibility();
    }

    function updateUIVisibility() {
        const guestTabs = ['home', 'search', 'internships', 'about'];
        const memberTabs = [...guestTabs, 'portfolio', 'transactions', 'presentations'];
        const adminTabs = [...memberTabs, 'admin'];

        let visibleTabs;
        switch (currentUserRole) {
            case 'member': visibleTabs = memberTabs; break;
            case 'admin': visibleTabs = adminTabs; break;
            default: visibleTabs = guestTabs; // guest
        }

        // Show/hide nav links
        document.querySelectorAll('.nav-link').forEach(link => {
            link.style.display = visibleTabs.includes(link.dataset.tab) ? 'block' : 'none';
        });

        // If current tab is now hidden, switch to home
        const activeTab = document.querySelector('.nav-link.active')?.dataset.tab;
        if (!visibleTabs.includes(activeTab)) {
            activateTab('home');
        }

        // Show/hide admin buttons
        const isAdmin = currentUserRole === 'admin';
        document.getElementById('editAboutBtn').classList.toggle('hidden', !isAdmin);
        document.getElementById('editInternshipsBtn').classList.toggle('hidden', !isAdmin);
        document.getElementById('addSectionBtn').style.display = isAdmin ? 'block' : 'none';

        // Re-render content that depends on role
        renderSearchTab(currentStockData);
        renderPresentations();
        renderPortfolioDashboard();
        renderTransactionHistory();
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
            case 'internships': /* Fetched on init */ break;
            case 'about': /* Fetched on init */ break;
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
    async function fetchPortfolio() {
        try {
            const response = await fetch('/api/portfolio');
            if (!response.ok) throw new Error('Failed to fetch portfolio');
            portfolio = await response.json();
        } catch (error) {
            console.error("Fetch portfolio error:", error);
            portfolio = [];
        }
    }

    async function addStockToPortfolio() {
        if (!currentStockData) return;
        const isReal = document.getElementById('isRealCheckbox').checked;
        
        const newHolding = {
            symbol: currentStockData.info.symbol,
            longName: currentStockData.info.longName,
            isReal: isReal,
            price: currentStockData.market_data.currentPrice,
            sector: currentStockData.info.sector || 'Other'
        };

        if (isReal) {
            if (currentUserRole !== 'admin') {
                alert("Only admins can add real transactions.");
                return;
            }
            const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
            newHolding.purchaseType = purchaseType;
            newHolding.date = document.getElementById('purchaseDate').value;

            if (purchaseType === 'quantity') {
                newHolding.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
                newHolding.price = parseFloat(document.getElementById('purchasePrice').value);
                if (isNaN(newHolding.quantity) || isNaN(newHolding.price) || !newHolding.date) {
                    alert("Please fill in all purchase details."); return;
                }
                newHolding.dollarValue = newHolding.quantity * newHolding.price;
            } else { // 'value'
                newHolding.dollarValue = parseFloat(document.getElementById('purchaseValue').value);
                const purchasePrice = parseFloat(document.getElementById('purchasePriceByValue').value);

                if (isNaN(newHolding.dollarValue) || isNaN(purchasePrice) || !newHolding.date) {
                    alert("Please fill in all purchase details: Dollar Value, Price per Share, and Date.");
                    return;
                }

                newHolding.price = purchasePrice;

                if (purchasePrice > 0) {
                    newHolding.quantity = newHolding.dollarValue / purchasePrice;
                } else {
                    newHolding.quantity = 0;
                }
            }
        }

        const response = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newHolding) });
        if (response.ok) {
            const addedHolding = await response.json();
            portfolio.push(addedHolding);
            alert(`${newHolding.symbol} has been added.`);
            activateTab('portfolio');
        } else {
            alert("Failed to add holding.");
        }
    }

    function promptForDelete(id) {
        if (currentUserRole !== 'admin') {
            alert("Only admins can delete holdings.");
            return;
        }
        holdingToDeleteId = id;
        showConfirmationModal();
    }

    async function confirmDelete() {
        if (holdingToDeleteId === null) return;
        try {
            const response = await fetch(`/api/portfolio/${holdingToDeleteId}`, { method: 'DELETE' });
            if (response.ok) {
                portfolio = portfolio.filter(h => h.id !== holdingToDeleteId);
                const currentTab = document.querySelector('.nav-link.active')?.dataset.tab;
                if (currentTab) activateTab(currentTab);
            } else {
                alert(`Failed to delete: ${(await response.json()).error}`);
            }
        } catch (error) {
            console.error("Error deleting holding:", error);
        } finally {
            hideConfirmationModal();
            holdingToDeleteId = null;
        }
    }

    async function updateHoldingSection(holdingId, newSection) {
        const holding = portfolio.find(h => h.id === holdingId);
        if (holding) holding.customSection = newSection;

        await fetch('/api/portfolio/section', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: holdingId, section: newSection })
        });
    }
    
    // --- CONTENT MANAGEMENT ---
    async function fetchPageContent(pageName) {
        try {
            const response = await fetch(`/api/page/${pageName}`);
            const data = await response.json();
            document.getElementById(`${pageName}PageContent`).innerHTML = data.content;
        } catch (error) {
            console.error(`Error fetching ${pageName} content:`, error);
        }
    }

    async function toggleContentEditable(pageName) {
        const contentDiv = document.getElementById(`${pageName}PageContent`);
        const editBtn = document.getElementById(`edit${pageName.charAt(0).toUpperCase() + pageName.slice(1)}Btn`);
        const addCardBtn = document.getElementById(`add${pageName.charAt(0).toUpperCase() + pageName.slice(1)}CardBtn`);
        const isEditable = contentDiv.isContentEditable;

        if (isEditable) {
            // Save content
            contentDiv.contentEditable = false;
            editBtn.textContent = 'Edit';
            editBtn.classList.remove('button-success');
            editBtn.classList.add('button-secondary');
            addCardBtn.classList.add('hidden');
            
            await fetch(`/api/page/${pageName}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: contentDiv.innerHTML })
            });
        } else {
            // Enable editing
            contentDiv.contentEditable = true;
            editBtn.textContent = 'Save';
            editBtn.classList.remove('button-secondary');
            editBtn.classList.add('button-success');
            addCardBtn.classList.remove('hidden');
            contentDiv.focus();
        }
    }

    function addContentCard(pageName) {
        const imageUrl = prompt("Please enter the URL for the image:");
        if (!imageUrl) return;

        const textContent = prompt("Please enter the text content for the card:");
        if (textContent === null) return;

        const cardHtml = `
            <div class="content-card">
                <div class="content-card-image-wrapper">
                    <img src="${imageUrl}" alt="User uploaded content">
                </div>
                <div class="content-card-text">
                    <p>${textContent}</p>
                </div>
            </div>`;

        const contentDiv = document.getElementById(`${pageName}PageContent`);
        contentDiv.insertAdjacentHTML('beforeend', cardHtml);
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
                        ${['5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'].map(t => `<button class="timeframe-btn" data-range="${t}">${t}</button>`).join('')}
                    </div>
                    <div class="chart-container" style="height: 400px;"><canvas id="stockChart"></canvas></div>
                </div>
                ${currentUserRole !== 'guest' ? getAddToPortfolioHtml(info.symbol) : ''}
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
            
            searchContent.querySelectorAll('.timeframe-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    searchContent.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    updateChartByRange(data.historical, btn.dataset.range);
                });
            });
            searchContent.querySelector('.timeframe-btn[data-range="1Y"]')?.classList.add('active');
            updateChartByRange(data.historical, '1Y');

            if (currentUserRole !== 'guest') {
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
                addToPortfolioBtn.addEventListener('click', addStockToPortfolio);
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
                            <input type="number" step="any" id="purchaseQuantity" placeholder="Quantity (e.g., 10)" class="form-input">
                            <input type="number" step="any" id="purchasePrice" placeholder="Price per Share" class="form-input">
                        </div>
                    </div>
                    <div>
                        <label for="purchaseDate" class="block text-sm font-medium text-gray-400 mb-1">Purchase Date</label>
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
        if (!summaryList) return;

        // Don't show loading message on silent auto-refresh
        if (summaryList.innerHTML === '') {
            summaryList.innerHTML = '<p class="col-span-full text-center text-gray-500 card">No holdings yet.</p>';
        }

        if (portfolio.length === 0) {
            summaryList.innerHTML = '<p class="col-span-full text-center text-gray-500 card">No holdings yet.</p>';
            return;
        }

        try {
            const tickers = [...new Set(portfolio.map(p => p.symbol))];
            const response = await fetch('/api/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tickers }) });
            if (!response.ok) throw new Error('Failed to fetch quotes');
            
            const quotes = await response.json();
            summaryList.innerHTML = ''; // Clear previous content before re-rendering
            portfolio.forEach(holding => {
                const quote = quotes[holding.symbol];
                const currentPrice = quote?.currentPrice ?? holding.price;
                const priceChange = currentPrice - (quote?.previousClose ?? holding.price);
                const priceChangePercent = (quote?.previousClose ?? 0) > 0 ? (priceChange / quote.previousClose) * 100 : 0;
                const changeColor = priceChange >= 0 ? 'text-green-400' : 'text-red-400';
                
                const card = document.createElement('div');
                card.className = 'summary-card';
                card.dataset.symbol = holding.symbol;
                card.innerHTML = `
                    <button class="delete-btn" data-id="${holding.id}" title="Delete"><i class="fas fa-times-circle"></i></button>
                    <div class="summary-card-content">
                        <div class="flex justify-between items-center">
                            <p class="font-bold text-lg">${holding.symbol}</p>
                            <p class="font-semibold text-lg">${currentPrice != null ? '$' + currentPrice.toFixed(2) : 'N/A'}</p>
                        </div>
                        <p class="text-sm text-gray-400 truncate">${holding.longName}</p>
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
        const realTransactions = portfolio.filter(item => item.isReal);

        listEl.innerHTML = '';
        if (realTransactions.length === 0) {
            listEl.innerHTML = '<tr><td colspan="8" class="text-center p-4 text-gray-500">No real transactions.</td></tr>';
            return;
        }

        realTransactions.forEach(item => {
            const row = document.createElement('tr');
            row.className = 'border-b border-gray-800 hover:bg-gray-800';
            const purchaseDetail = item.purchaseType === 'quantity' ? `${(item.quantity || 0).toFixed(4)} shares` : `$${(item.dollarValue || 0).toFixed(2)}`;
            row.innerHTML = `
                <td class="p-3">${item.date || 'N/A'}</td>
                <td class="p-3 font-bold"><a href="#" class="transaction-link text-cyan-400 hover:underline" data-symbol="${item.symbol}">${item.symbol}</a></td>
                <td class="p-3">${item.longName}</td>
                <td class="p-3">Buy</td>
                <td class="p-3 text-right">${purchaseDetail}</td>
                <td class="p-3 text-right">$${(item.price || 0).toFixed(2)}</td>
                <td class="p-3 text-right font-semibold">$${(item.dollarValue || 0).toFixed(2)}</td>
                <td class="p-3 text-center"><button class="delete-btn" data-id="${item.id}"><i class="fas fa-times-circle"></i></button></td>
            `;
            listEl.appendChild(row);
        });
    }

    async function renderPresentations() {
        const listEl = document.getElementById('presentationList');
        const submitCard = document.getElementById('submitPresentationCard');

        if (currentUserRole === 'guest') {
            submitCard.style.display = 'none';
        } else {
            submitCard.style.display = 'block';
        }

        if (!listEl) return;
        listEl.innerHTML = '<p class="card">Loading presentations...</p>';
        try {
            const response = await fetch('/api/presentations');
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
                const voteButtons = `<button class="vote-btn" data-id="${p.id}" data-type="for"><i class="fas fa-thumbs-up text-green-500"></i><span class="ml-2">${p.votesFor}</span></button><button class="vote-btn" data-id="${p.id}" data-type="against"><i class="fas fa-thumbs-down text-red-500"></i><span class="ml-2">${p.votesAgainst}</span></button>`;
                card.innerHTML = `<h4 class="text-xl font-bold">${p.title}</h4><p class="text-sm text-gray-400 mb-3">Proposing to <span class="font-bold ${actionColor}">${p.action} ${p.ticker}</span></p><a href="${p.url}" target="_blank" rel="noopener noreferrer" class="text-cyan-400 hover:underline mb-4 block">View Presentation</a><div class="flex items-center justify-end space-x-4">${voteButtons}</div>`;
                listEl.appendChild(card);
            });
            listEl.querySelectorAll('.vote-btn').forEach(btn => btn.addEventListener('click', handleVote));
        } catch (error) {
            listEl.innerHTML = '<p class="card text-red-400">Could not load presentations.</p>';
        }
    }

    async function renderPortfolioDashboard(newSectionName = null) {
        const sectionsEl = document.getElementById('portfolioSections');
        const realHoldings = portfolio.filter(p => p.isReal && p.quantity > 0);

        if (realHoldings.length === 0 && !newSectionName) {
            sectionsEl.innerHTML = '<p class="card text-center text-gray-500">No real holdings to analyze.</p>';
            return;
        }

        const quotes = await fetchQuotesForHoldings(realHoldings);
        const sections = groupHoldingsBySection(realHoldings, quotes);
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

        updatePortfolioTotals(sections);
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

    function groupHoldingsBySection(holdings, quotes) {
        const sections = {};
        holdings.forEach(h => {
            const sectionName = h.customSection || h.sector || 'Uncategorized';
            if (!sections[sectionName]) {
                sections[sectionName] = { holdings: [], totalCost: 0, currentValue: 0 };
            }
            const quote = quotes[h.symbol];
            const currentValue = (h.quantity || 0) * (quote?.currentPrice ?? h.price ?? 0);
            sections[sectionName].holdings.push({ ...h, currentValue });
            sections[sectionName].totalCost += h.dollarValue || 0;
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
        const gainLoss = h.currentValue - h.dollarValue;
        const gainLossPercent = h.dollarValue > 0 ? (gainLoss / h.dollarValue) * 100 : 0;
        const gainLossColor = gainLoss >= 0 ? 'text-green-400' : 'text-red-400';
        const holdingWeight = sectionValue > 0 ? (h.currentValue / sectionValue) * 100 : 0;

        return `
            <div class="card bg-gray-800 p-3 flex justify-between items-center" data-id="${h.id}">
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
        Object.values(sections).forEach(s => {
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
        if (currentUserRole !== 'admin') return;
        const holdingLists = document.querySelectorAll('.holding-list');
        holdingLists.forEach(list => {
            new Sortable(list, {
                group: 'portfolio',
                animation: 150,
                ghostClass: 'sortable-ghost',
                onEnd: function (evt) {
                    const holdingId = parseInt(evt.item.dataset.id);
                    const newSectionName = evt.to.closest('.portfolio-section').dataset.sectionName;
                    updateHoldingSection(holdingId, newSectionName);
                },
            });
        });
    }

    // --- UI HELPERS & MODAL ---
    function showConfirmationModal() { document.getElementById('confirmationModal')?.classList.remove('hidden'); }
    function hideConfirmationModal() { document.getElementById('confirmationModal')?.classList.add('hidden'); }

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
            alert('Failed to record vote.');
        }
    }

    // --- CHARTING ---
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
                                return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
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
            case '5D': startDate.setDate(now.getDate() - 5); break;
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
        stockChart.update();
    }

    // --- START THE APP ---
    initialize();
});
