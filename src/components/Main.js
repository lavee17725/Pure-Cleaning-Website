import Header from "./Header"
import Home from "../pages/Home"
import Services from "../pages/Services"
import Comparison from "../pages/Comparison"
import Contact from "../pages/Contact"
import Quote from "../pages/Quote"
import Footer from "./Footer"
import Reviews from "../pages/Reviews"

export default function Main() {
    return (
        <div className="App">
      <Header />
      <Home />
      <Services />
      <Comparison />
      <Reviews />
      <Contact />
      <Quote />
      <Footer />
    </div>
    )
}