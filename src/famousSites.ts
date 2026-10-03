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
];
