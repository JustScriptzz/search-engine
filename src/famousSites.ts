// Allowlist of famous sites, plus the entry URLs worth indexing for each.
// Two jobs:
//  1. discovery seeds for the Common Crawl-backed `discover` command
//  2. "site cards": homepages of these hosts are link farms with almost no
//     text, so instead of dropping them we index a minimal card (title +
//     description). That way searching "google" returns google.com itself
//     rather than pages that merely mention it.
export interface FamousSite {
  name: string;
  url: string;
}

export const FAMOUS_SITES: FamousSite[] = [
  // search & tech
  { name: "Google", url: "https://www.google.com" },
  { name: "Bing", url: "https://www.bing.com" },
  { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/Main_Page" },
  { name: "GitHub", url: "https://github.com" },
  { name: "Stack Overflow", url: "https://stackoverflow.com" },
  { name: "Hacker News", url: "https://news.ycombinator.com" },
  { name: "MDN", url: "https://developer.mozilla.org" },
  { name: "Stack Overflow Blog", url: "https://stackoverflow.blog" },
  { name: "Cloudflare", url: "https://blog.cloudflare.com" },
  { name: "Netflix Tech", url: "https://netflixtechblog.com" },
  { name: "Amazon Web Services", url: "https://aws.amazon.com/blogs/" },
  { name: "Kubernetes", url: "https://kubernetes.io/blog/" },
  { name: "Rust", url: "https://blog.rust-lang.org" },
  { name: "Python", url: "https://blog.python.org" },
  { name: "Node.js", url: "https://nodejs.org/en/blog" },
  { name: "React", url: "https://react.dev/blog" },
  { name: "Apple Newsroom", url: "https://www.apple.com/newsroom/" },
  { name: "Microsoft News", url: "https://blogs.microsoft.com/blog/" },
  { name: "Meta Engineering", url: "https://engineering.fb.com" },
  { name: "OpenAI", url: "https://openai.com/news/" },
  // news
  { name: "BBC News", url: "https://www.bbc.com/news" },
  { name: "Reuters", url: "https://www.reuters.com" },
  { name: "Associated Press", url: "https://apnews.com" },
  { name: "NPR", url: "https://www.npr.org" },
  { name: "The Guardian", url: "https://www.theguardian.com/international" },
  { name: "Al Jazeera", url: "https://www.aljazeera.com" },
  { name: "CNN", url: "https://edition.cnn.com" },
  { name: "NBC News", url: "https://www.nbcnews.com" },
  { name: "CBS News", url: "https://www.cbsnews.com" },
  { name: "ABC News", url: "https://abcnews.go.com" },
  { name: "Sky News", url: "https://news.sky.com" },
  { name: "France 24", url: "https://www.france24.com/en/" },
  { name: "Deutsche Welle", url: "https://www.dw.com/en/top-stories/s-9097" },
  { name: "NHK", url: "https://www3.nhk.or.jp/nhnews/en/" },
  { name: "CBC", url: "https://www.cbc.ca/news" },
  { name: "Ars Technica", url: "https://arstechnica.com" },
  { name: "The Verge", url: "https://www.theverge.com" },
  { name: "TechCrunch", url: "https://techcrunch.com" },
  { name: "Wired", url: "https://www.wired.com" },
  { name: "Engadget", url: "https://www.engadget.com" },
  { name: "Vice", url: "https://www.vice.com/en" },
  { name: "Politico", url: "https://www.politico.com" },
  { name: "Axios", url: "https://www.axios.com" },
  { name: "The Atlantic", url: "https://www.theatlantic.com" },
  // science & nature
  { name: "NASA", url: "https://www.nasa.gov" },
  { name: "ESA", url: "https://www.esa.int" },
  { name: "Nature", url: "https://www.nature.com/news" },
  { name: "Science Magazine", url: "https://www.science.org" },
  { name: "Phys.org", url: "https://phys.org" },
  { name: "Quanta", url: "https://www.quantamagazine.org" },
  { name: "Smithsonian", url: "https://www.smithsonianmag.com" },
  { name: "NIH", url: "https://www.nih.gov" },
  // reference & misc
  { name: "Britannica", url: "https://www.britannica.com" },
  { name: "Merriam-Webster", url: "https://www.merriam-webster.com" },
  { name: "Wolfram Alpha", url: "https://www.wolframalpha.com" },
  { name: "Khan Academy", url: "https://www.khanacademy.org" },
  { name: "Coursera", url: "https://www.coursera.org" },
  { name: "MIT OpenCourseWare", url: "https://ocw.mit.edu" },
  { name: "Project Gutenberg", url: "https://www.gutenberg.org" },
  { name: "Internet Archive", url: "https://archive.org" },
  { name: "Library of Congress", url: "https://www.loc.gov" },
  // Italy
  { name: "ANSA", url: "https://www.ansa.it" },
  { name: "Corriere della Sera", url: "https://www.corriere.it" },
  { name: "La Repubblica", url: "https://www.repubblica.it" },
  { name: "Rai", url: "https://www.rainews.it" },
  { name: "Treccani", url: "https://www.treccani.it/enciclopedia/" },

  // Social networks. Note the reality of robots.txt here: instagram, x,
  // facebook, pinterest and reddit answer "Disallow: /" to every crawler, so a
  // polite crawl can never reach them. They are listed anyway because
  // `ccimport` pulls their pages from Common Crawl (which they *do* allow)
  // instead of from the origin. tiktok only opens /foryou /discover /about.
  { name: "Instagram", url: "https://www.instagram.com" },
  { name: "TikTok", url: "https://www.tiktok.com/about" },
  { name: "X", url: "https://x.com" },
  { name: "Facebook", url: "https://www.facebook.com" },
  { name: "Reddit", url: "https://www.reddit.com" },
  { name: "Pinterest", url: "https://www.pinterest.com" },
  { name: "LinkedIn", url: "https://www.linkedin.com" },
  { name: "Threads", url: "https://www.threads.net" },
  { name: "Mastodon", url: "https://mastodon.social" },
  { name: "Bluesky", url: "https://bsky.app" },
  { name: "Tumblr", url: "https://www.tumblr.com" },
  { name: "Snapchat", url: "https://www.snapchat.com" },
  { name: "Discord", url: "https://discord.com" },

  // Video, streaming & audio
  { name: "Twitch", url: "https://www.twitch.tv" },
  { name: "Vimeo", url: "https://vimeo.com" },
  { name: "Dailymotion", url: "https://www.dailymotion.com" },
  { name: "Spotify", url: "https://open.spotify.com" },
  { name: "SoundCloud", url: "https://soundcloud.com" },
  { name: "Bandcamp", url: "https://bandcamp.com" },
  { name: "Mixcloud", url: "https://www.mixcloud.com" },
  { name: "IMDb", url: "https://www.imdb.com" },
  { name: "Letterboxd", url: "https://letterboxd.com" },

  // Developer communities & platforms
  { name: "Dev.to", url: "https://dev.to" },
  { name: "Hashnode", url: "https://hashnode.com" },
  { name: "Product Hunt", url: "https://www.producthunt.com" },
  { name: "Hacker News", url: "https://news.ycombinator.com" },
  { name: "Lobsters", url: "https://lobste.rs" },
  { name: "SourceForge", url: "https://sourceforge.net" },
  { name: "GitLab", url: "https://gitlab.com" },
  { name: "Bitbucket", url: "https://bitbucket.org" },
  { name: "CodePen", url: "https://codepen.io" },
  { name: "npm", url: "https://www.npmjs.com" },
  { name: "PyPI", url: "https://pypi.org" },
  { name: "Docker Hub", url: "https://hub.docker.com" },
  { name: "Kaggle", url: "https://www.kaggle.com" },
  { name: "Replit", url: "https://replit.com" },

  // Reference, docs & learning
  { name: "MDN Web Docs", url: "https://developer.mozilla.org" },
  { name: "Can I Use", url: "https://caniuse.com" },
  { name: "Khan Academy", url: "https://www.khanacademy.org" },
  { name: "MIT OpenCourseWare", url: "https://ocw.mit.edu" },
  { name: "Coursera", url: "https://www.coursera.org" },
  { name: "edX", url: "https://www.edx.org" },
  { name: "freeCodeCamp", url: "https://www.freecodecamp.org" },
  { name: "Smashing Magazine", url: "https://www.smashingmagazine.com" },
  { name: "CSS-Tricks", url: "https://css-tricks.com" },
  { name: "Web.dev", url: "https://developer.chrome.com/docs" },
  { name: "OWASP", url: "https://owasp.org" },
  { name: "OpenStreetMap", url: "https://www.openstreetmap.org" },
  { name: "Wolfram Alpha", url: "https://www.wolframalpha.com" },
  { name: "Merriam-Webster", url: "https://www.merriam-webster.com" },

  // Shopping, travel & food
  { name: "Wikipedia (IT)", url: "https://it.wikipedia.org/wiki/Italia" },
  { name: "TripAdvisor", url: "https://www.tripadvisor.com" },
  { name: "Airbnb", url: "https://www.airbnb.com" },
  { name: "Booking.com", url: "https://www.booking.com" },
  { name: "Zillow", url: "https://www.zillow.com" },
  { name: "Allrecipes", url: "https://www.allrecipes.com" },
  { name: "Yelp", url: "https://www.yelp.com" },
  { name: "eBay", url: "https://www.ebay.com" },

  // Regional press beyond the US
  { name: "Der Spiegel", url: "https://www.spiegel.de" },
  { name: "Le Monde", url: "https://www.lemonde.fr" },
  { name: "El País", url: "https://elpais.com" },
  { name: "RTL Nieuws", url: "https://www.rtlnieuws.nl" },
  { name: "Aftonbladet", url: "https://www.aftonbladet.se" },
  { name: "NRK", url: "https://www.nrk.no" },
  { name: "Yle", url: "https://yle.fi" },
  { name: "NHK World", url: "https://www3.nhk.or.jp" },
];
