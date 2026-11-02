// squad-kit 1.0 is out, so the coming-soon address now sends every visitor to the same page on squad-kit.com.
export default {
  fetch(request) {
    const url = new URL(request.url);
    return Response.redirect(`https://squad-kit.com${url.pathname}${url.search}`, 301);
  },
};
