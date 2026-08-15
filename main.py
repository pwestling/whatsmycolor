from fasthtml.common import serve

from whatsmycolor.app import app as whatsmycolor_app


# Keep the ASGI entrypoint explicit for Vercel's Python runtime scanner.
app = whatsmycolor_app


if __name__ == "__main__":
    serve()

