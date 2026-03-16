import cloudscraper from 'cloudscraper';
import cheerio from 'cheerio';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_URL = 'https://raw.githubusercontent.com/CloudWaddie/ModelWatcher/master/logo.jpg';

/**
 * Load configuration from uspto-config.json
 */
function loadConfig() {
  const configPath = join(__dirname, '..', 'uspto-config.json');
  const configContent = readFileSync(configPath, 'utf-8');
  return JSON.parse(configContent);
}

/**
 * Load state from state file
 */
function loadState(statePath) {
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'));
      // Convert arrays back to Sets
      for (const slug in data.companies) {
        if (Array.isArray(data.companies[slug].seenSerials)) {
          data.companies[slug].seenSerials = new Set(data.companies[slug].seenSerials);
        }
      }
      return data;
    } catch (e) {
      console.error('Failed to parse state file, starting fresh:', e.message);
    }
  }
  return { companies: {} };
}

/**
 * Save state to state file
 */
function saveState(statePath, state) {
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Convert Sets to arrays for JSON serialization
  const stateToSave = { companies: {} };
  for (const slug in state.companies) {
    stateToSave.companies[slug] = {
      seenSerials: Array.from(state.companies[slug].seenSerials)
    };
  }
  writeFileSync(statePath, JSON.stringify(stateToSave, null, 2));
}

/**
 * Initialize cloudscraper with browser-like settings
 */
function createScraper() {
  return cloudscraper.create({
    browser: {
      browser: 'chrome',
      platform: 'windows',
      desktop: true,
      mobile: false
    },
    interpreter: 'native',
    debug: false
  });
}

/**
 * Wait for Cloudflare challenge to complete
 */
async function waitForCloudflare(html, scraper, url, maxAttempts = 5) {
  let currentHtml = html;
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    const $ = cheerio.load(currentHtml);
    
    // Check for "Just a moment..." Cloudflare challenge
    const challengeText = $('body').text();
    if (challengeText.includes('Just a moment') || challengeText.includes('Checking your browser')) {
      console.log('Detected Cloudflare challenge, waiting...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try fetching again after waiting
      try {
        currentHtml = await scraper.get(url);
      } catch (err) {
        console.log('Retry after challenge wait:', err.message);
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
        continue;
      }
      attempts++;
      continue;
    }
    
    // Check for captcha/turnstile challenge
    const hasCaptcha = $('#cf-content .cf-captcha').length > 0 || 
                       $('iframe[src*="turnstile"]').length > 0 ||
                       $('div[class*="turnstile"]').length > 0;
    
    if (hasCaptcha) {
      console.log('Detected CAPTCHA/Turnstile challenge');
      // Wait for manual intervention or try again
      await new Promise(resolve => setTimeout(resolve, 5000));
      try {
        currentHtml = await scraper.get(url);
      } catch (err) {
        attempts++;
        continue;
      }
      attempts++;
      continue;
    }
    
    // No challenge detected, return the HTML
    return currentHtml;
  }
  
  console.warn('Max Cloudflare challenge attempts reached');
  return currentHtml;
}

/**
 * Fetch trademark filings using cloudscraper with DOM parsing
 */
async function fetchCompanyFilings(companySlug) {
  console.log(`Fetching USPTO data for ${companySlug}...`);

  const url = `https://uspto.report/company/${companySlug}`;
  const scraper = createScraper();
  
  try {
    // Initial request
    let html = await scraper.get(url);
    
    // Wait for Cloudflare challenges to resolve
    html = await waitForCloudflare(html, scraper, url);
    
    const $ = cheerio.load(html);
    
    // Check if we got a valid page or an error
    const pageTitle = $('title').text();
    if (pageTitle.includes('Access denied') || pageTitle.includes('Blocked')) {
      console.error('Access blocked by USPTO/Cloudflare');
      return [];
    }
    
    // Parse the filings from the table
    const filings = [];
    
    // Look for table rows with trademark links
    $('table tr').each((_, row) => {
      const $row = $(row);
      const link = $row.find('a[href^="/TM/"]');
      
      if (!link.length) return;
      
      const url = link.attr('href');
      const serialMatch = url.match(/\/TM\/(\d+)/);
      const serial = serialMatch ? serialMatch[1] : null;
      if (!serial) return;
      
      // Get mark name
      let mark = link.find('div').text().trim();
      if (!mark) {
        const img = link.find('img');
        mark = img.attr('alt') || 'Symbol/Image';
      }
      
      // Get date - look for floating right div or date pattern
      const dateText = $row.find('div[style*="float: right"]').text();
      const dateMatch = dateText.match(/(\d{4}-\d{2}-\d{2})/);
      const date = dateMatch ? dateMatch[1] : null;
      
      // Get image URL
      const img = link.find('img');
      const imageUrl = img.attr('src') || null;
      
      if (serial && mark && date) {
        filings.push({
          serial,
          mark: mark.trim(),
          date,
          url: `https://uspto.report${url}`,
          imageUrl: imageUrl || `https://uspto.report/TM/${serial}/mark.png`
        });
      }
    });
    
    // Sort by date (newest first)
    filings.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    console.log(`Found ${filings.length} trademark filings for ${companySlug}`);
    return filings;
    
  } catch (error) {
    console.error(`Failed to fetch USPTO data for ${companySlug}:`, error.message);
    return [];
  }
}

/**
 * Send a Discord webhook notification
 */
async function sendDiscordWebhook(webhookUrl, payload) {
  if (!webhookUrl) {
    console.log('Discord webhook URL not configured, skipping notification');
    return false;
  }

  // Dynamically import axios only when needed (for webhook)
  const { default: axios } = await import('axios');
  
  try {
    await axios.post(webhookUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (err) {
    const details = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Failed to send Discord webhook:', err.response?.status, details);
    return false;
  }
}

/**
 * Get Discord relative timestamp
 */
function getRelativeTimestamp() {
  const unixSeconds = Math.floor(Date.now() / 1000);
  return `<t:${unixSeconds}:R>`;
}

/**
 * Create Discord message for new trademark filings with embeds and images
 */
function createNewFilingsMessage(company, filings) {
  const embeds = [];
  const companySlug = company.slug;
  const companyName = company.name;
  
  // If too many filings, just show summary
  if (filings.length > 10) {
    return {
      username: 'USPTO Watcher',
      avatar_url: LOGO_URL,
      embeds: [{
        title: '🏛️ New Trademark Filings',
        description: `**${companyName}** filed **${filings.length}** new trademark applications ${getRelativeTimestamp()}!`,
        url: `https://uspto.report/company/${companySlug}`,
        color: 0x2563EB,
        timestamp: new Date().toISOString(),
        footer: {
          text: 'USPTO Trademark Watcher',
          icon_url: LOGO_URL
        }
      }]
    };
  }
  
  // Create an embed for each filing
  for (const filing of filings) {
    const embed = {
      title: filing.mark,
      description: `**Serial:** ${filing.serial}\n**Date:** ${filing.date}`,
      url: filing.url,
      color: 0x2563EB,
      timestamp: new Date().toISOString(),
      footer: {
        text: 'USPTO Trademark Watcher',
        icon_url: LOGO_URL
      }
    };
    
    // Add thumbnail image if available
    if (filing.imageUrl) {
      embed.thumbnail = {
        url: filing.imageUrl
      };
    }
    
    embeds.push(embed);
  }
  
  return {
    username: 'USPTO Watcher',
    avatar_url: LOGO_URL,
    content: `🏛️ **New Trademark Filings from ${companyName}**\n\n${companyName} filed ${filings.length} new trademark application${filings.length > 1 ? 's' : ''} ${getRelativeTimestamp()}!`,
    embeds: embeds
  };
}

/**
 * Main function
 */
async function main() {
  console.log('=== USPTO Trademark Watcher ===');
  console.log('Starting trademark check...');

  const config = loadConfig();
  const statePath = join(__dirname, '..', config.state?.file || 'logs/uspto-state.json');
  const state = loadState(statePath);

  const webhookUrl = process.env[config.webhook?.webhookEnv];

  if (!webhookUrl) {
    console.error(`Webhook URL not configured (${config.webhook?.webhookEnv} env not set), exiting`);
    process.exit(1);
  }

  const companies = config.companies || [];
  console.log(`Watching ${companies.length} company(ies): ${companies.map(c => c.name).join(', ')}`);

  let totalNewFilings = 0;

  for (const company of companies) {
    const filings = await fetchCompanyFilings(company.slug);

    if (filings.length === 0) {
      console.log(`No filings found for ${company.name}`);
      continue;
    }

    // Initialize company state if needed
    if (!state.companies[company.slug]) {
      state.companies[company.slug] = { seenSerials: new Set() };
    }

    // Find new filings using Set for O(1) lookup
    const seenSerials = state.companies[company.slug].seenSerials;
    const newFilings = filings.filter(filing => !seenSerials.has(filing.serial));

    // Sort new filings by date (newest first)
    newFilings.sort((a, b) => new Date(b.date) - new Date(a.date));

    if (newFilings.length > 0) {
      console.log(`Found ${newFilings.length} new trademark filings for ${company.name}`);
      
      // Send webhook notification
      const message = createNewFilingsMessage(company, newFilings);
      await sendDiscordWebhook(webhookUrl, message);

      totalNewFilings += newFilings.length;

      // Update seen serials
      for (const filing of newFilings) {
        seenSerials.add(filing.serial);
      }
    } else {
      console.log(`No new trademark filings for ${company.name}`);
    }
  }

  // Save state
  saveState(statePath, state);

  console.log(`=== Trademark check complete: ${totalNewFilings} new filings ===`);
}

// Run main function
main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
