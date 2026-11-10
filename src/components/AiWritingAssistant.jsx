import { useEffect, useRef, useState } from 'react'
import { supabase } from '../supabaseClient'

const MAX_DRAFT_LENGTH = 6000


  const [suggestion, setSuggestion] = useState('')
  const [suggestionDraft, setSuggestionDraft] = useState('')
  const [explanation, setExplanation] = useState('')
  const [explanationDraft, setExplanationDraft] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [errorDraft, setErrorDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [online, setOnline] = useState(() => navigator.onLine)
  const requestInProgress = useRef(false)

  useEffect(() => {
    const handleOnline = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  const currentSuggestion = suggestionDraft === value ? suggestion : ''
  const currentExplanation = explanationDraft === value ? explanation : ''
  const currentError = errorDraft === value ? errorMessage : ''

  const requestAssistance = async (action) => {
    if (requestInProgress.current) return
    setErrorDraft(value)
    if (!online) {
      setErrorMessage('Connect to the internet to use the AI Writing Assistant.')
      return
    }
    if (!value.trim()) {
      setErrorMessage('Write a draft before asking for writing help.')
      return
    }
    if (value.length > MAX_DRAFT_LENGTH) {
      setErrorMessage(`Please limit this draft to ${MAX_DRAFT_LENGTH.toLocaleString()} characters.`)
      return
    }

    requestInProgress.current = true
    setLoading(true)
    setErrorMessage('')
    if (action === 'revise') {
      setExplanation('')
      setSuggestionDraft('')
      setExplanationDraft('')
    }

    try {
      const { data, error } = await supabase.functions.invoke('ai-writing-assistant', {
        body: {
          action,
          context,
          draft: value,
          suggestion: action === 'explain' ? currentSuggestion : undefined,
        },
      })

      if (error) {
        let detail = error.message
        if (error.context instanceof Response) {
          try {
            const responseBody = await error.context.clone().json()
            detail = responseBody.error || detail
          } catch {
            detail = error.message
          }
        }
        if (detail === 'Failed to send a request to the Edge Function') {
          detail = 'The writing assistant is unavailable. Please try again, or contact support if the problem continues.'
        }
        throw new Error(detail || 'The writing assistant request failed.')
      }
      if (typeof data?.suggestion !== 'string' || !data.suggestion.trim()) {
        throw new Error('The writing assistant returned an invalid suggestion.')
      }
      if (action === 'revise') {
        setSuggestion(data.suggestion)
        setSuggestionDraft(value)
        setExplanation('')
      } else {
        if (typeof data?.explanation !== 'string' || !data.explanation.trim()) {
          throw new Error('The writing assistant could not explain these corrections.')
        }
        setExplanation(data.explanation)
        setExplanationDraft(value)
      }
    } catch (error) {
      console.error('AI writing assistance failed:', error)
      setErrorDraft(value)
      setErrorMessage(error?.message || 'Could not get a writing suggestion. Please try again.')
    } finally {
      requestInProgress.current = false
      setLoading(false)
    }
  }

  const blocked = disabled || loading || !online || !value.trim() ||
    value.length > MAX_DRAFT_LENGTH

  return (
    <details className="ai-writing-assistant">
      <summary>
        <span>AI Writing Assistant</span>
        <span className="ai-writing-limit">
          {value.length.toLocaleString()}/{MAX_DRAFT_LENGTH.toLocaleString()}
        </span>
      </summary>
      <div className="ai-writing-assistant-content">
        <p className="ai-writing-intro">
          Suggestions use only your draft. Review them before applying.
        </p>

        <p className="ai-writing-privacy">
          Your draft and writing type are sent to the secure assistant. When you request an
          explanation, the suggested revision is sent too. Do not include sensitive personal
          information. This app does not save assistant requests; provider data handling
          follows your OpenAI account terms. AI help requires internet access.
        </p>

        <div className="ai-writing-actions">
          <button
            type="button"
            onClick={() => requestAssistance('revise')}
            disabled={blocked}
          >
            {loading ? 'Working...' : currentSuggestion ? 'Try Again' : 'Improve Draft'}
          </button>
          <button
            type="button"
            onClick={() => requestAssistance('explain')}
            disabled={disabled || loading || !online || !currentSuggestion}
          >
            Explain Corrections
          </button>
          <button
            type="button"
            className="ai-writing-use"
            onClick={() => onUseSuggestion(currentSuggestion)}
            disabled={disabled || loading || !currentSuggestion}
          >
            Use Suggestion
          </button>
        </div>

        {!online && (
          <p className="ai-writing-message" role="status">
            AI writing help is unavailable offline. Your draft remains available as usual.
          </p>
        )}
        {currentError && (
          <p className="ai-writing-error" role="alert">{currentError}</p>
        )}

        {currentSuggestion && (
          <div className="ai-writing-comparison">
            <div>
              <h4>Original draft</h4>
              <p>{value}</p>
            </div>
            <div>
              <h4>Suggested revision</h4>
              <p>{currentSuggestion}</p>
            </div>
          </div>
        )}

        {currentExplanation && (
          <div className="ai-writing-explanation" role="status">
            <h4>Why these corrections?</h4>
            <p>{currentExplanation}</p>
          </div>
        )}
      </div>
    </details>
  )



