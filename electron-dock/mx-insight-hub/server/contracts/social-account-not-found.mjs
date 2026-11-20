// A typed lookup miss, distinct from an empty content page or invalid response.
// The workflow attaches the original supplier receipt and the public HTTP code.
export class SocialAccountNotFoundError extends Error {
  constructor() {
    super('The requested account was not found')
    this.name = 'SocialAccountNotFoundError'
  }
}
