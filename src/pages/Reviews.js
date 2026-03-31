import React, { useEffect, useState } from "react";

export default function Reviews() {
  return (
    <div>
      <section className="review-header">Five Star Reviews</section>
      <div className="angis-reviews">
        <div
          className="angi-container"
          style={{ width: "80%", height: "600px", overflow: "auto" }}
        >
          <iframe
            src="https://www.angi.com/companylist/us/fl/ft-lauderdale/pure-cleaning-pressure-cleaning-reviews-2354397.htm"
            title="Angie's List Reviews"
            width="90%"
            height="90%"
            frameBorder="0"
          />
        </div>
      </div>
    </div>
  );
}
