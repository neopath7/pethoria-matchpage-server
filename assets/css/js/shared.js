/* PeThoria Shared JavaScript - Dark Mode, Notifications, Interactive Features */

class PeThoriaApp {
  constructor() {
    this.theme = localStorage.getItem('theme') || 'light';
    this.notifications = [];
    this.stats = {};
    this.init();
  }

  init() {
    this.initTheme();
    this.initNotifications();
    this.initEventListeners();
    this.initResponsiveFeatures();
    this.loadStats();
    this.startPeriodicUpdates();
  }

  // Theme Management
  initTheme() {
    document.documentElement.setAttribute('data-theme', this.theme);
    this.createThemeToggle();
  }

  createThemeToggle() {
    // Check if toggle already exists
    if (document.querySelector('.theme-toggle')) return;

    const toggle = document.createElement('button');
    toggle.className = 'theme-toggle';
    toggle.innerHTML = `
      <i class="icon fas fa-${this.theme === 'dark' ? 'sun' : 'moon'}"></i>
      <span>${this.theme === 'dark' ? 'Light' : 'Dark'}</span>
    `;
    toggle.addEventListener('click', () => this.toggleTheme());
    document.body.appendChild(toggle);
  }

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    localStorage.setItem('theme', this.theme);
    document.documentElement.setAttribute('data-theme', this.theme);
    
    const toggle = document.querySelector('.theme-toggle');
    const icon = toggle.querySelector('.icon');
    const text = toggle.querySelector('span');
    
    icon.className = `icon fas fa-${this.theme === 'dark' ? 'sun' : 'moon'}`;
    text.textContent = this.theme === 'dark' ? 'Light' : 'Dark';
    
    toggle.classList.add('active');
    setTimeout(() => toggle.classList.remove('active'), 300);
    
    // Emit theme change event
    window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme: this.theme } }));
  }

  // Notification System
  initNotifications() {
    // Create notification container if it doesn't exist
    if (!document.querySelector('.notification-container')) {
      const container = document.createElement('div');
      container.className = 'notification-container';
      container.id = 'notificationContainer';
      document.body.appendChild(container);
    }
  }

  showNotification(title, message, type = 'info', duration = 5000) {
    const id = Date.now().toString();
    const notification = {
      id,
      title,
      message,
      type,
      timestamp: Date.now()
    };

    this.notifications.push(notification);
    this.renderNotification(notification);

    // Auto remove after duration
    if (duration > 0) {
      setTimeout(() => this.removeNotification(id), duration);
    }

    return id;
  }

  renderNotification(notification) {
    const container = document.getElementById('notificationContainer');
    const element = document.createElement('div');
    element.className = 'notification';
    element.setAttribute('data-id', notification.id);
    
    const iconMap = {
      success: 'check',
      warning: 'exclamation-triangle',
      error: 'times',
      info: 'info-circle'
    };

    element.innerHTML = `
      <div class="notification-icon ${notification.type}">
        <i class="fas fa-${iconMap[notification.type]}"></i>
      </div>
      <div class="notification-content">
        <div class="notification-title">${notification.title}</div>
        <div class="notification-message">${notification.message}</div>
      </div>
      <button class="notification-close" onclick="app.removeNotification('${notification.id}')">
        <i class="fas fa-times"></i>
      </button>
    `;

    container.appendChild(element);

    // Add click to dismiss
    element.addEventListener('click', (e) => {
      if (!e.target.closest('.notification-close')) {
        this.removeNotification(notification.id);
      }
    });
  }

  removeNotification(id) {
    const element = document.querySelector(`[data-id="${id}"]`);
    if (element) {
      element.classList.add('removing');
      setTimeout(() => {
        element.remove();
        this.notifications = this.notifications.filter(n => n.id !== id);
      }, 300);
    }
  }

  // Quick Stats System
  loadStats() {
    // Simulate loading stats from API
    this.updateStats({
      totalUsers: { value: 2847, trend: 'up', change: '+12%' },
      activeMatches: { value: 156, trend: 'up', change: '+8%' },
      messagesExchanged: { value: 8934, trend: 'up', change: '+23%' },
      successfulMatches: { value: 234, trend: 'up', change: '+15%' },
      totalRevenue: { value: '$12,450', trend: 'up', change: '+18%' },
      avgResponseTime: { value: '2.3min', trend: 'down', change: '-5%' }
    });
  }

  updateStats(newStats) {
    this.stats = { ...this.stats, ...newStats };
    this.renderStats();
  }

  renderStats() {
    const container = document.getElementById('quickStatsContainer');
    if (!container) return;

    const statsHTML = Object.entries(this.stats).map(([key, stat]) => {
      const iconMap = {
        totalUsers: 'users',
        activeMatches: 'heart',
        messagesExchanged: 'comments',
        successfulMatches: 'handshake',
        totalRevenue: 'dollar-sign',
        avgResponseTime: 'clock'
      };

      const labelMap = {
        totalUsers: 'Total Users',
        activeMatches: 'Active Matches',
        messagesExchanged: 'Messages Today',
        successfulMatches: 'Successful Matches',
        totalRevenue: 'Revenue This Month',
        avgResponseTime: 'Avg Response Time'
      };

      return `
        <div class="stat-card fade-in">
          <div class="stat-header">
            <div class="stat-icon">
              <i class="fas fa-${iconMap[key]}"></i>
            </div>
            <div class="stat-trend ${stat.trend}">
              <i class="fas fa-arrow-${stat.trend === 'up' ? 'up' : 'down'}"></i>
              ${stat.change}
            </div>
          </div>
          <div class="stat-value">${stat.value}</div>
          <div class="stat-label">${labelMap[key]}</div>
          <div class="stat-description">Last 30 days comparison</div>
        </div>
      `;
    }).join('');

    container.innerHTML = statsHTML;
  }

  // Real-time Updates
  startPeriodicUpdates() {
    // Update stats every 30 seconds
    setInterval(() => {
      this.loadStats();
      this.checkForNotifications();
    }, 30000);

    // Simulate random notifications for demo
    this.startDemoNotifications();
  }

  startDemoNotifications() {
    const demoNotifications = [
      { title: 'New Match!', message: 'You have a new pet match with Luna the Golden Retriever', type: 'success' },
      { title: 'Message Received', message: 'Sarah sent you a message about the playdate', type: 'info' },
      { title: 'Match Request', message: 'Max the Labrador wants to be friends!', type: 'info' },
      { title: 'System Update', message: 'New features are now available in your dashboard', type: 'warning' },
      { title: 'Reward Earned', message: 'You earned 50 points for being active!', type: 'success' }
    ];

    let notificationIndex = 0;
    setInterval(() => {
      if (Math.random() > 0.7) { // 30% chance every interval
        const notification = demoNotifications[notificationIndex % demoNotifications.length];
        this.showNotification(notification.title, notification.message, notification.type);
        notificationIndex++;
      }
    }, 15000); // Every 15 seconds
  }

  checkForNotifications() {
    // In a real app, this would check for new notifications from the server
    // For now, we'll simulate this
    if (window.location.pathname.includes('dashboard.html')) {
      // Simulate checking for new orders, messages, etc.
      this.simulateRealtimeUpdates();
    }
  }

  simulateRealtimeUpdates() {
    // Simulate real-time stat updates
    const randomUpdate = Math.random();
    if (randomUpdate > 0.8) {
      const currentUsers = parseInt(this.stats.totalUsers?.value) || 2847;
      this.updateStats({
        totalUsers: { 
          value: currentUsers + Math.floor(Math.random() * 10), 
          trend: 'up', 
          change: `+${Math.floor(Math.random() * 5) + 1}%` 
        }
      });
    }
  }

  // Responsive Features
  initResponsiveFeatures() {
    this.handleMobileNavigation();
    this.initTouchGestures();
    this.optimizeForMobile();
  }

  handleMobileNavigation() {
    // Add mobile menu toggle for responsive navigation
    const nav = document.querySelector('nav, header');
    if (nav && window.innerWidth <= 768) {
      this.createMobileMenu(nav);
    }
  }

  createMobileMenu(nav) {
    const existingToggle = nav.querySelector('.mobile-menu-toggle');
    if (existingToggle) return;

    const toggle = document.createElement('button');
    toggle.className = 'mobile-menu-toggle';
    toggle.innerHTML = '<i class="fas fa-bars"></i>';
    toggle.style.cssText = `
      display: none;
      background: none;
      border: none;
      font-size: 1.5rem;
      color: var(--text-primary);
      cursor: pointer;
      padding: 8px;
    `;

    // Show toggle on mobile
    if (window.innerWidth <= 768) {
      toggle.style.display = 'block';
    }

    toggle.addEventListener('click', () => {
      nav.classList.toggle('mobile-menu-open');
    });

    nav.appendChild(toggle);
  }

  initTouchGestures() {
    // Add swipe gestures for mobile
    let startX, startY, endX, endY;

    document.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    });

    document.addEventListener('touchend', (e) => {
      endX = e.changedTouches[0].clientX;
      endY = e.changedTouches[0].clientY;
      this.handleSwipe(startX, startY, endX, endY);
    });
  }

  handleSwipe(startX, startY, endX, endY) {
    const deltaX = endX - startX;
    const deltaY = endY - startY;
    const minSwipeDistance = 50;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > minSwipeDistance) {
      if (deltaX > 0) {
        // Swipe right
        this.handleSwipeRight();
      } else {
        // Swipe left
        this.handleSwipeLeft();
      }
    }
  }

  handleSwipeRight() {
    // Handle swipe right gesture
    window.dispatchEvent(new CustomEvent('swipeRight'));
  }

  handleSwipeLeft() {
    // Handle swipe left gesture
    window.dispatchEvent(new CustomEvent('swipeLeft'));
  }

  optimizeForMobile() {
    // Optimize images for mobile
    this.lazyLoadImages();
    
    // Optimize animations for low-power devices
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.body.classList.add('reduced-motion');
    }
  }

  lazyLoadImages() {
    const images = document.querySelectorAll('img[data-src]');
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          img.src = img.dataset.src;
          img.removeAttribute('data-src');
          observer.unobserve(img);
        }
      });
    });

    images.forEach(img => imageObserver.observe(img));
  }

  // Event Listeners
  initEventListeners() {
    // Window resize handler
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.handleResize();
      }, 250);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      this.handleKeyboardShortcuts(e);
    });

    // Page visibility change
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.pauseUpdates();
      } else {
        this.resumeUpdates();
      }
    });

    // Custom events
    window.addEventListener('themeChanged', (e) => {
      this.onThemeChanged(e.detail.theme);
    });
  }

  handleResize() {
    // Update mobile menu visibility
    const mobileToggle = document.querySelector('.mobile-menu-toggle');
    if (mobileToggle) {
      mobileToggle.style.display = window.innerWidth <= 768 ? 'block' : 'none';
    }

    // Adjust notification container
    const notificationContainer = document.querySelector('.notification-container');
    if (notificationContainer && window.innerWidth <= 768) {
      notificationContainer.style.left = '10px';
      notificationContainer.style.right = '10px';
      notificationContainer.style.maxWidth = 'none';
    }
  }

  handleKeyboardShortcuts(e) {
    // Theme toggle with Ctrl/Cmd + D
    if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
      e.preventDefault();
      this.toggleTheme();
    }

    // Clear notifications with Escape
    if (e.key === 'Escape') {
      this.clearAllNotifications();
    }
  }

  clearAllNotifications() {
    const notifications = document.querySelectorAll('.notification');
    notifications.forEach(notification => {
      const id = notification.getAttribute('data-id');
      this.removeNotification(id);
    });
  }

  pauseUpdates() {
    this.updatesPaused = true;
  }

  resumeUpdates() {
    this.updatesPaused = false;
    this.checkForNotifications();
  }

  onThemeChanged(theme) {
    // Handle theme change effects
    if (theme === 'dark') {
      this.showNotification('Dark Mode', 'Switched to dark theme', 'info', 2000);
    } else {
      this.showNotification('Light Mode', 'Switched to light theme', 'info', 2000);
    }
  }

  // Utility Methods
  formatNumber(num) {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
  }

  formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  }

  formatTime(timestamp) {
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(timestamp));
  }

  // Animation Utilities
  animateNumber(element, start, end, duration = 1000) {
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;

    const timer = setInterval(() => {
      current += increment;
      if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
        current = end;
        clearInterval(timer);
      }
      element.textContent = Math.floor(current);
    }, 16);
  }

  // API Helpers
  async fetchWithAuth(url, options = {}) {
    const token = localStorage.getItem('token');
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        ...(token && { 'Authorization': `Bearer ${token}` })
      }
    };

    return fetch(url, { ...defaultOptions, ...options });
  }

  // Performance Monitoring
  initPerformanceMonitoring() {
    // Monitor page load performance
    window.addEventListener('load', () => {
      const perfData = performance.getEntriesByType('navigation')[0];
      console.log('Page Load Time:', perfData.loadEventEnd - perfData.loadEventStart);
    });
  }
}

// Initialize the app
const app = new PeThoriaApp();

// Make app globally available
window.PeThoriaApp = app;

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PeThoriaApp;
}

// Add some utility functions to global scope
window.showNotification = (title, message, type, duration) => 
  app.showNotification(title, message, type, duration);

window.toggleTheme = () => app.toggleTheme();

// Service Worker Registration (for PWA features)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => console.log('SW registered'))
      .catch(registrationError => console.log('SW registration failed'));
  });
} 
