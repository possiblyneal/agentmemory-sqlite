// NLTK's English stopword list, contractions split as the tokenizer splits
// them. Dropped from BM25 query terms only: in a small or homogeneous store a
// function word's IDF is high enough to rank a document on "how", "my" or
// "should" alone, and its prefix expansion ("do" -> "domain") adds more.
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "about", "above", "after", "again", "against", "ain", "all", "am", "an", "and",
  "any", "are", "aren", "as", "at", "be", "because", "been", "before", "being",
  "below", "between", "both", "but", "by", "can", "couldn", "did", "didn", "do",
  "does", "doesn", "doing", "don", "down", "during", "each", "few", "for", "from",
  "further", "had", "hadn", "has", "hasn", "have", "haven", "having", "he", "her",
  "here", "hers", "herself", "him", "himself", "his", "how", "if", "in", "into",
  "is", "isn", "it", "its", "itself", "just", "ll", "ma", "me", "mightn", "more",
  "most", "mustn", "my", "myself", "needn", "no", "nor", "not", "now", "of", "off",
  "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over",
  "own", "re", "same", "shan", "she", "should", "shouldn", "so", "some", "such",
  "than", "that", "the", "their", "theirs", "them", "themselves", "then", "there",
  "these", "they", "this", "those", "through", "to", "too", "under", "until", "up",
  "ve", "very", "was", "wasn", "we", "were", "weren", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "won", "wouldn", "you",
  "your", "yours", "yourself", "yourselves",
]);
