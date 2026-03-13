# Viewer Setup & Deployment

The web-based replay viewer allows anyone to:
- Upload and preview Trigger workflows
- Share workflows as URL-encoded links
- Execute workflows (when using the Chrome extension)

## Local Development

### 1. Start a Local Server

```bash
# Using Python 3
cd /home/parth/code\ \Trigger/viewer
python3 -m http.server 8080

# Or using Node.js (http-server)
npx http-server viewer -p 8080

# Or using Live Server extension in VS Code
# Open index.html and click "Go Live"
```

Then open: **http://localhost:8080**

### 2. Test with a Workflow

Record a workflow using the Chrome extension, then:

1. Click the **🔗 Share** button in the extension popup
2. The share URL is copied to clipboard
3. Paste it in your browser (or send to others)
4. The viewer loads and displays the workflow steps

### 3. Preview Without Extension

Use the **Upload** or **Paste JSON** tabs to load workflows directly without the extension.

## Production Deployment

### Deploy to Netlify (Recommended)

1. **Create a Netlify account**: https://netlify.com

2. **Connect your repository**:
   ```bash
   git add .
   git commit -m "Add Trigger viewer"
   git push origin main
   ```

3. **Create new site from git**:
   - Select your repository
   - Build command: (leave empty)
   - Publish directory: `viewer`
   - Click Deploy

4. **Update the share URL in popup.js**:
   
   In `extension/popup/popup.js`, line ~174:
   ```javascript
   const viewerUrl = 'https://your-netlify-site.netlify.app';
   ```

5. **Enable CORS** (if needed):
   
   Create `viewer/netlify.toml`:
   ```toml
   [[headers]]
   for = "/*"
   [headers.values]
   Access-Control-Allow-Origin = "*"
   ```

### Deploy to GitHub Pages

1. **Enable GitHub Pages**:
   - Go to Settings → Pages
   - Source: Deploy from branch
   - Branch: `main`, folder: `/viewer`

2. **Update share URL**:
   ```javascript
   const viewerUrl = 'https://YOUR-USERNAME.github.io/Trigger';
   ```

3. **Push to deploy**:
   ```bash
   git push origin main
   ```

### Deploy to Vercel

1. **Connect your repository**:
   https://vercel.com/new

2. **Configure**:
   - Root directory: `viewer`
   - Create Environment Variable: (none needed)

3. **Deploy** and update share URL

### Deploy to AWS S3

1. **Create S3 bucket** (enable static hosting)
2. **Upload contents of `viewer/` folder**
3. **CloudFront CDN** (optional, for caching)
4. **Update share URL** to your S3 domain

## URL Sharing Format

Share links look like:
```
https://your-viewer-domain.com?workflow={url-encoded-json}
```

The entire workflow is encoded in the URL, so:
- ✅ No server needed (client-side only)
- ✅ Works offline once loaded
- ✅ Completely stateless
- ⚠️ URLs can get very long (10-50KB workflows → very long URLs)
- ⚠️ Share via URL shortener if needed

### URL Shortener

For long workflows, use a URL shortener:

```bash
# Using TinyURL API
curl "https://tinyurl.com/api-create.php?url=${LONG_URL}"

# Using Bitly (requires API key)
curl -H "Authorization: Bearer YOUR_BITLY_TOKEN" \
  -X POST https://api-ssl.bitly.com/v4/shorten \
  -H "Content-Type: application/json" \
  -d '{"long_url": "'${LONG_URL}'"}'
```

## Configuration

### Custom Branding

Edit `viewer/index.html`:

```html
<!-- Change title -->
<title>Trigger Replay Viewer</title>

<!-- Change header -->
<h1>⚡ Trigger Replay Viewer</h1>

<!-- Change colors -->
:root {
  --primary-color: #667eea;  /* Change this */
  --secondary-color: #764ba2;
}
```

### Analytics

Add Google Analytics to `viewer/index.html`:

```html
<!-- Google Analytics -->
<script async src="https://www.googletagmanager.com/gtag/js?id=GA_MEASUREMENT_ID"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'GA_MEASUREMENT_ID');
</script>
```

## Testing the Viewer

### Test Upload
1. Export a workflow as JSON from the extension
2. Use the **Upload** tab to load it
3. Verify all steps are displayed correctly

### Test URL Sharing
1. Click **Share** in the extension popup
2. Copy the generated URL
3. Open in a new tab
4. Verify the workflow previews correctly
5. Click **↗ Open Start URL** to verify the domain

### Test Different Workflows
- Short workflows (1-3 steps)
- Long workflows (20+ steps)
- With sensitive fields (passwords)
- With navigation steps
- With form inputs

## Troubleshooting

### "Failed to parse workflow from URL"
- The JSON might be corrupted during URL encoding
- Try using **Upload** or **Paste JSON** instead
- Check browser console (F12) for details

### "Share link is too long"
- Simplified workflows reduce URL length
- Use a URL shortener service
- Export as JSON instead

### "Element not found" during execution
- The page structure changed since recording
- Try re-recording on the latest version
- Use the assisted mode to verify elements

### Viewer won't load
- Check that `index.html` and `viewer.js` are in same folder
- Verify you're accessing via HTTP/HTTPS (not `file://`)
- Check browser console for JavaScript errors

## Performance

### Optimizations Implemented
- ✅ Shadow DOM for isolated rendering
- ✅ Efficient fingerprinting (single pass)
- ✅ Polling with exponential backoff for element detection
- ✅ Minimal DOM mutations during replay

### Large Workflows
- Workflows with 100+ steps will have longer replay times
- Keep replays under 30 steps for best UX
- Split long sequences into multiple workflows

## Security Considerations

### For Deployment

1. **HTTPS only**: Always use HTTPS, never HTTP
   - Workflows contain sensitive information
   - URLs are logged in browser history

2. **Content Security Policy**:
   ```html
   <meta http-equiv="Content-Security-Policy" 
         content="default-src 'self'; script-src 'self' 'unsafe-inline'">
   ```

3. **CORS Headers**:
   ```
   Access-Control-Allow-Origin: *
   Access-Control-Allow-Methods: GET
   ```

4. **Never log workflow content**:
   - Workflows may contain passwords or PII
   - Sanitize any analytics/logging

### User Privacy

- ⚠️ URL parameters appear in browser history
- ⚠️ URLs may be logged by web servers
- ✅ Sensitive fields are marked as `sensitive: true`
- ✅ Values redacted in UI for sensitive fields
- ✅ All processing is client-side

---

**Questions?** Check the main [README.md](../README.md) for extension usage.
